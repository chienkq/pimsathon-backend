import type { NormalizedTicket } from "@chienkq/workflow-core";
import * as XLSX from "xlsx";

/**
 * Column names Jira's own "Export Excel CSV (all fields)"/"(current fields)" actions produce vary by
 * Jira version/locale, so each logical field is matched against several known aliases rather than one
 * fixed header string. Matching is case/whitespace-insensitive.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  key: ["issue key", "key"],
  title: ["summary", "title"],
  status: ["status"],
  priority: ["priority"],
  assignee: ["assignee"],
  projectKey: ["project key", "project"],
  storyPoints: ["story points", "custom field (story points)", "story point", "original story points"],
  sprint: ["sprint"],
  issueType: ["issue type", "type"],
  epicLink: ["epic link"],
  epicName: ["epic name"],
  components: ["component/s", "components"],
  fixVersions: ["fix version/s", "fix versions"],
  labels: ["labels"],
  dueDate: ["due date"],
};

/**
 * Jira's own export puts multiple values for a multi-select field (Components, Fix Version/s, Labels)
 * in one cell, separated by a comma or a newline — never both consistently, so split on either.
 */
function splitMultiValue(raw: unknown): string[] | undefined {
  const value = String(raw ?? "").trim();
  if (!value) return undefined;
  const parts = value
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/**
 * A date-like cell in a CSV export gets type-inferred by `xlsx` into an Excel date serial number
 * (e.g. `46295` for "30-Sep-26"), not a string — so it needs the standard Excel-epoch conversion rather
 * than `new Date(String(value))`, which would silently mis-parse the raw serial number as a garbage
 * date instead. (Not using `XLSX.SSF.parse_date_code` here: under Node ESM, `import * as XLSX` only
 * exposes the named exports `cjs-module-lexer` can statically find, which misses `SSF` — it's only
 * reachable as `XLSX.default.SSF` there, so the direct epoch math below is used instead.) A genuine
 * text export (a real `.xlsx` typically doesn't hit this) still falls back to plain string parsing.
 */
function parseDueDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    // Excel's day-0 is 1899-12-30 (its epoch, adjusted for the 1900 leap-year bug); 25569 is the
    // number of days from there to the Unix epoch (1970-01-01) — the standard SheetJS conversion.
    const utcMs = Math.round((value - 25569) * 86400 * 1000);
    const asDate = new Date(utcMs);
    return Number.isNaN(asDate.getTime()) ? undefined : asDate.toISOString().slice(0, 10);
  }
  const asDate = new Date(String(value).trim());
  return Number.isNaN(asDate.getTime()) ? undefined : asDate.toISOString().slice(0, 10);
}

/**
 * Short, deterministic id for a row that has no Jira issue key — this app's own backlog/planning
 * exports (e.g. a wider "general_report" dump covering both real Jira issues and not-yet-ticketed
 * feature rows) can have plenty of rows like that. Derived from the project + title so the same row
 * re-imported later upserts in place instead of duplicating, without needing a real Jira key to key off.
 */
function syntheticKey(projectKey: string, title: string): string {
  let hash = 0;
  const input = `${projectKey}|${title}`;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return `${projectKey || "ROW"}-NOKEY-${(hash >>> 0).toString(36)}`;
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

/**
 * Jira's own Excel export declares a sheet dimension (`!ref`) that spans the entire worksheet
 * (e.g. a million rows) because formatting was applied to whole columns, even though only a few
 * hundred rows actually hold data. `sheet_to_json` walks the declared range cell-by-cell, so without
 * trimming it first, parsing one of these files can take minutes instead of milliseconds. Populated
 * cells are sparse keys on the sheet object, so finding the real bounds from them is cheap.
 */
function actualDataRange(sheet: XLSX.WorkSheet): { s: XLSX.CellAddress; e: XLSX.CellAddress } | undefined {
  let maxRow = -1;
  let maxCol = -1;
  for (const key of Object.keys(sheet)) {
    if (key[0] === "!") continue;
    const { r, c } = XLSX.utils.decode_cell(key);
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }
  return maxRow < 0 ? undefined : { s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } };
}

/** Maps each logical field to the actual column header present in this file, if any. */
function resolveColumns(headers: string[]): Partial<Record<keyof typeof COLUMN_ALIASES, string>> {
  const normalizedToOriginal = new Map(headers.map((h) => [normalizeHeader(h), h]));
  const resolved: Partial<Record<keyof typeof COLUMN_ALIASES, string>> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const match = aliases.map(normalizeHeader).find((alias) => normalizedToOriginal.has(alias));
    if (match) resolved[field as keyof typeof COLUMN_ALIASES] = normalizedToOriginal.get(match);
  }
  return resolved;
}

/**
 * Jira's "printable"/dashboard-style Excel export (sheet named e.g. `general_report`) isn't a flat
 * table — its first couple of rows are a filter title and an "Displaying N issues at ..." caption
 * before the real column header row, so row 0 can't be assumed to be the header. Scans down the sheet
 * (as raw rows, not yet parsed as objects) for the first row that resolves both a key and a title
 * column.
 */
function findHeaderRow(sheet: XLSX.WorkSheet, range: { s: XLSX.CellAddress; e: XLSX.CellAddress }): number | undefined {
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", range });
  for (let i = 0; i < rows.length; i++) {
    const columns = resolveColumns(rows[i].map(String));
    if (columns.key && columns.title) return range.s.r + i;
  }
  return undefined;
}

export interface JiraExcelImportResult {
  tickets: NormalizedTicket[];
  skipped: number;
}

/**
 * Parses a Jira Excel export (.xlsx/.xls/.csv) into the same `NormalizedTicket` shape the live
 * Jira sync workflow produces (see workflow-core's `ticketUpsert` node), using `provider: "jira"` and
 * `externalId`/`externalKey` = the issue key so an imported row merges with a live-synced one for the
 * same issue instead of duplicating it.
 */
export function parseJiraExcelImport(buffer: Buffer): JiraExcelImportResult {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("The uploaded file has no sheets.");
  const sheet = workbook.Sheets[sheetName];
  const dataRange = actualDataRange(sheet);
  if (!dataRange) throw new Error("The uploaded file has no data.");

  const headerRow = findHeaderRow(sheet, dataRange);
  if (headerRow === undefined) {
    throw new Error('Could not find a header row with an "Issue key" and a "Summary" column in the uploaded file.');
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    range: { s: { r: headerRow, c: dataRange.s.c }, e: dataRange.e },
  });
  // `findHeaderRow` already confirmed a key and a title column resolve on this same header row, so
  // both are guaranteed present here — re-resolved (rather than reused) because it's derived from the
  // parsed data rows' own keys, which is what `row[...]` below actually indexes into.
  const columns = resolveColumns(Object.keys(rows[0] ?? {}));
  const keyColumn = columns.key!;
  const titleColumn = columns.title!;

  const tickets: NormalizedTicket[] = [];
  let skipped = 0;

  for (const row of rows) {
    const title = String(row[titleColumn] ?? "").trim();
    if (!title) {
      skipped += 1;
      continue;
    }

    const projectKey = columns.projectKey ? String(row[columns.projectKey] ?? "").trim() : "";
    // Not every row in a wide planning export (e.g. a backlog dump covering both real Jira issues and
    // not-yet-ticketed feature rows) carries a real Jira issue key — those still get imported (title is
    // the only hard requirement) under a synthetic, deterministic key instead of being dropped.
    const rawKey = String(row[keyColumn] ?? "").trim();
    const key = rawKey || syntheticKey(projectKey, title);

    const storyPointsRaw = columns.storyPoints ? row[columns.storyPoints] : undefined;
    const storyPoints =
      storyPointsRaw !== undefined && storyPointsRaw !== "" && !Number.isNaN(Number(storyPointsRaw))
        ? Number(storyPointsRaw)
        : undefined;

    const dueDate = columns.dueDate ? parseDueDate(row[columns.dueDate]) : undefined;

    tickets.push({
      provider: "jira",
      externalId: key,
      externalKey: key,
      projectKey: projectKey || (rawKey ? rawKey.split("-")[0] : "") || "ROW",
      title,
      status: columns.status ? String(row[columns.status] ?? "").trim() || "Unknown" : "Unknown",
      priority: columns.priority ? String(row[columns.priority] ?? "").trim() || undefined : undefined,
      assignee: columns.assignee ? String(row[columns.assignee] ?? "").trim() || undefined : undefined,
      storyPoints,
      sprintId: columns.sprint ? String(row[columns.sprint] ?? "").trim() || undefined : undefined,
      issueType: columns.issueType ? String(row[columns.issueType] ?? "").trim() || undefined : undefined,
      epicKey: columns.epicLink ? String(row[columns.epicLink] ?? "").trim() || undefined : undefined,
      epicName: columns.epicName ? String(row[columns.epicName] ?? "").trim() || undefined : undefined,
      components: columns.components ? splitMultiValue(row[columns.components]) : undefined,
      fixVersions: columns.fixVersions ? splitMultiValue(row[columns.fixVersions]) : undefined,
      labels: columns.labels ? splitMultiValue(row[columns.labels]) : undefined,
      dueDate,
      raw: row,
    });
  }

  return { tickets, skipped };
}
