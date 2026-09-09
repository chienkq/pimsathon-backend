import type { NormalizedWorkItemFact } from "@chienkq/workflow-core";
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
  storyPoints: ["story points", "custom field (story points)"],
  sprint: ["sprint"],
};

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
  facts: NormalizedWorkItemFact[];
  skipped: number;
}

/**
 * Parses a Jira Excel export (.xlsx/.xls/.csv) into the same `NormalizedWorkItemFact` shape the live
 * Jira sync workflow produces (see workflow-core's `factUpsert` node), using `provider: "jira"` and
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

  const facts: NormalizedWorkItemFact[] = [];
  let skipped = 0;

  for (const row of rows) {
    const key = String(row[keyColumn] ?? "").trim();
    const title = String(row[titleColumn] ?? "").trim();
    if (!key || !title) {
      skipped += 1;
      continue;
    }

    const projectKey = columns.projectKey ? String(row[columns.projectKey] ?? "").trim() : "";
    const storyPointsRaw = columns.storyPoints ? row[columns.storyPoints] : undefined;
    const storyPoints =
      storyPointsRaw !== undefined && storyPointsRaw !== "" && !Number.isNaN(Number(storyPointsRaw))
        ? Number(storyPointsRaw)
        : undefined;

    facts.push({
      provider: "jira",
      externalId: key,
      externalKey: key,
      projectKey: projectKey || key.split("-")[0],
      title,
      status: columns.status ? String(row[columns.status] ?? "").trim() || "Unknown" : "Unknown",
      priority: columns.priority ? String(row[columns.priority] ?? "").trim() || undefined : undefined,
      assignee: columns.assignee ? String(row[columns.assignee] ?? "").trim() || undefined : undefined,
      storyPoints,
      sprintId: columns.sprint ? String(row[columns.sprint] ?? "").trim() || undefined : undefined,
      raw: row,
    });
  }

  return { facts, skipped };
}
