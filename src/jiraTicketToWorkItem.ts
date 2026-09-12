import type { NormalizedTicket, StoredTicket } from "@chienkq/workflow-core";
import { planningGroups, projects, ticketSyncConflicts, workItems, type WorkflowDb } from "@chienkq/workflow-db";
import { and, eq, inArray, sql } from "drizzle-orm";

const STATUS_ALIASES: Record<string, "Todo" | "In Progress" | "In Review" | "Done" | "Cancelled"> = {
  "to do": "Todo",
  "open": "Todo",
  "backlog": "Todo",
  "new": "Todo",
  "in progress": "In Progress",
  "in review": "In Review",
  "review": "In Review",
  "in qa": "In Review",
  "done": "Done",
  "closed": "Done",
  "resolved": "Done",
  "cancelled": "Cancelled",
  "canceled": "Cancelled",
  "won't do": "Cancelled",
  "wont do": "Cancelled",
};

function mapStatus(jiraStatus: string): "Todo" | "In Progress" | "In Review" | "Done" | "Cancelled" {
  return STATUS_ALIASES[jiraStatus.trim().toLowerCase()] ?? "Todo";
}

const PRIORITY_ALIASES: Record<string, "Low" | "Medium" | "High" | "Urgent"> = {
  highest: "Urgent",
  urgent: "Urgent",
  blocker: "Urgent",
  high: "High",
  medium: "Medium",
  normal: "Medium",
  low: "Low",
  lowest: "Low",
};

function mapPriority(jiraPriority: string | undefined): "Low" | "Medium" | "High" | "Urgent" {
  if (!jiraPriority) return "Medium";
  return PRIORITY_ALIASES[jiraPriority.trim().toLowerCase()] ?? "Medium";
}

/** Finds an existing `planning_groups` row by (project, kind, case-insensitive name). */
async function findPlanningGroupId(
  db: WorkflowDb,
  projectId: string,
  kind: "cycle" | "module",
  name: string,
): Promise<string | undefined> {
  const [existing] = await db
    .select({ id: planningGroups.id })
    .from(planningGroups)
    .where(
      and(
        eq(planningGroups.projectId, projectId),
        eq(planningGroups.kind, kind),
        sql`lower(${planningGroups.name}) = ${name.trim().toLowerCase()}`,
      ),
    );
  return existing?.id;
}

/**
 * Finds an existing `planning_groups` row by (project, kind, case-insensitive name), or creates one —
 * used to fold Jira's Sprint field into this app's "cycle" concept and Fix Version/s into its "module"
 * concept (see the module-level doc comment on `mapTicketToPlanningGroups` below) so re-converting the
 * same ticket links back to the same cycle/module instead of creating a duplicate every time.
 */
async function ensurePlanningGroup(
  db: WorkflowDb,
  projectId: string,
  kind: "cycle" | "module",
  name: string,
): Promise<string> {
  const trimmed = name.trim();
  const existingId = await findPlanningGroupId(db, projectId, kind, trimmed);
  if (existingId) return existingId;

  const [created] = await db
    .insert(planningGroups)
    .values({ id: crypto.randomUUID(), projectId, kind, name: trimmed })
    .returning({ id: planningGroups.id });
  return created.id;
}

/** Resolves `planning_groups` ids to their names, for showing a work item's current cycle/modules by name in a diff. */
async function planningGroupNamesById(db: WorkflowDb, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: planningGroups.id, name: planningGroups.name }).from(planningGroups).where(inArray(planningGroups.id, ids));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * Turns a flat list of Jira Sprint or Fix Version/s values into real cycles/modules in `projectId` —
 * the Jira Sync screen's "Sprints" and "Modules" sections, a deliberate, reviewable pre-step ahead of
 * "Convert to work items" so a messy/duplicate Jira name can be caught before it becomes a cycle or
 * module, instead of only ever being created as a silent side effect of converting a work item (which
 * still happens too, via `mapTicketToPlanningGroups` below, as a fallback for anyone who skips this).
 * Case-insensitive de-duped both against existing rows and within `names` itself.
 */
export async function convertNamesToPlanningGroups(
  db: WorkflowDb,
  projectId: string,
  kind: "cycle" | "module",
  names: string[],
): Promise<{ created: number; existing: number }> {
  let created = 0;
  let existing = 0;
  const seen = new Set<string>();

  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const existingId = await findPlanningGroupId(db, projectId, kind, name);
    if (existingId) {
      existing += 1;
    } else {
      await ensurePlanningGroup(db, projectId, kind, name);
      created += 1;
    }
  }

  return { created, existing };
}

/**
 * Resolves a ticket's Sprint field to a cycle and its Fix Version/s to one module per distinct version —
 * the only two Jira grouping fields with a structural equivalent in this app (`cycleId`/`moduleIds`, see
 * `domain/types.ts`'s `PlanningGroup`: cycle ≈ sprint, module ≈ a milestone-ish grouping, matching Jira's
 * own Fix Version semantics). Epic Link/Name, Components and Issue Type have no such equivalent here, so
 * they're preserved as work item labels instead (`ticketLabels` below) rather than dropped.
 */
async function mapTicketToPlanningGroups(
  db: WorkflowDb,
  projectId: string,
  ticket: NormalizedTicket,
): Promise<{ cycleId?: string; moduleIds: string[] }> {
  const cycleId = ticket.sprintId?.trim() ? await ensurePlanningGroup(db, projectId, "cycle", ticket.sprintId) : undefined;
  const moduleIds = ticket.fixVersions?.length
    ? await Promise.all(ticket.fixVersions.map((version) => ensurePlanningGroup(db, projectId, "module", version)))
    : [];
  return { cycleId, moduleIds };
}

/** Everything from the ticket with no structural home on the work item, kept as tags instead of dropped. */
function ticketLabels(ticket: NormalizedTicket): string[] {
  const labels = new Set(ticket.labels ?? []);
  for (const component of ticket.components ?? []) labels.add(`component:${component}`);
  if (ticket.epicName) labels.add(`epic:${ticket.epicName}`);
  else if (ticket.epicKey) labels.add(`epic:${ticket.epicKey}`);
  if (ticket.issueType) labels.add(`type:${ticket.issueType}`);
  return [...labels];
}

async function ensureProject(db: WorkflowDb, projectKey: string): Promise<typeof projects.$inferSelect> {
  const code = projectKey || "JIRA";
  const [existing] = await db.select().from(projects).where(eq(projects.code, code));
  if (existing) return existing;

  const [created] = await db
    .insert(projects)
    .values({ id: crypto.randomUUID(), name: code, code, description: "Auto-created from a Jira import/sync." })
    .returning();
  return created;
}

/** The three `work_items` fields that are actually a 1:1 mirror of a Jira field — everything else
 *  (description, labels, etc.) is either synthesized or has no Jira-side equivalent to merge against. */
interface TicketMergeSnapshot {
  title: string;
  status: "Todo" | "In Progress" | "In Review" | "Done" | "Cancelled";
  priority: "Low" | "Medium" | "High" | "Urgent";
}

export interface TicketFieldConflict {
  field: keyof TicketMergeSnapshot;
  appValue: string;
  jiraValue: string;
}

interface TicketMergeResult {
  /** Only the fields safe to write — omits anything left unresolved as a conflict. */
  patch: Partial<TicketMergeSnapshot>;
  /** The new "last known Jira value" snapshot to persist as `externalSyncBase`. */
  newBase: TicketMergeSnapshot;
  conflicts: TicketFieldConflict[];
}

/**
 * Three-way merge (local `work_items` value vs incoming Jira value vs `base` — the Jira value as of
 * the last successful sync) so re-converting an already-linked ticket doesn't blindly overwrite a
 * local edit with whatever Jira currently has. No `base` yet means this is the first-ever sync for
 * this work item, so there's nothing to compare against — just adopt the Jira value.
 */
function mergeTicketFields(
  local: TicketMergeSnapshot,
  remote: TicketMergeSnapshot,
  base: TicketMergeSnapshot | null,
): TicketMergeResult {
  if (!base) return { patch: { ...remote }, newBase: { ...remote }, conflicts: [] };

  const patch: Partial<TicketMergeSnapshot> = {};
  const newBase: TicketMergeSnapshot = { ...base };
  const conflicts: TicketFieldConflict[] = [];

  for (const field of Object.keys(remote) as (keyof TicketMergeSnapshot)[]) {
    const localValue = local[field];
    const remoteValue = remote[field];
    const baseValue = base[field];

    if (localValue === remoteValue) {
      newBase[field] = remoteValue as never;
    } else if (localValue === baseValue) {
      // Only Jira changed since the last sync — safe to apply.
      patch[field] = remoteValue as never;
      newBase[field] = remoteValue as never;
    } else if (remoteValue === baseValue) {
      // Only the app changed since the last sync — keep the local edit, Jira hasn't moved.
    } else {
      // Both sides changed the same field to different values — can't resolve automatically.
      conflicts.push({ field, appValue: String(localValue), jiraValue: String(remoteValue) });
    }
  }

  return { patch, newBase, conflicts };
}

const FIELD_LABELS: Record<keyof TicketMergeSnapshot, string> = { title: "Title", status: "Status", priority: "Priority" };

/** One field that would change (or be set for the first time) if this ticket were converted. */
export interface TicketConversionChange {
  field: string;
  label: string;
  from: string;
  to: string;
}

export interface TicketConversionPreview {
  ticketId: string;
  externalKey: string;
  action: "create" | "update";
  workItemId?: string;
  /** Fields that would actually be written — everything shown here is exactly what "Convert to work items" will apply. */
  changes: TicketConversionChange[];
  /** Fields left unresolved by the three-way merge (both the app and Jira changed it) — shown, but NOT applied. */
  conflicts: TicketFieldConflict[];
}

function joinOrNone(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

/**
 * Computes, without writing anything, exactly what `convertTicketsToWorkItems` would change for each
 * ticket — the Jira Sync screen's "Preview changes" step, so a silent overwrite (this app always
 * replaces description/labels/cycle/module/due date/story points on conversion, only title/status/
 * priority go through the three-way merge) can be reviewed before it happens instead of only being
 * visible after the fact.
 */
export async function previewTicketConversions(db: WorkflowDb, ticketsToPreview: StoredTicket[]): Promise<TicketConversionPreview[]> {
  const results: TicketConversionPreview[] = [];

  for (const ticket of ticketsToPreview) {
    const [existing] = await db
      .select({
        id: workItems.id,
        projectId: workItems.projectId,
        title: workItems.title,
        status: workItems.status,
        priority: workItems.priority,
        description: workItems.description,
        cycleId: workItems.cycleId,
        moduleIds: workItems.moduleIds,
        labels: workItems.labels,
        dueDate: workItems.dueDate,
        storyPoints: workItems.storyPoints,
        externalSyncBase: workItems.externalSyncBase,
      })
      .from(workItems)
      .where(and(eq(workItems.externalProvider, ticket.provider), eq(workItems.externalKey, ticket.externalKey)));

    const changes: TicketConversionChange[] = [];
    const description = ticket.assignee
      ? `Imported from Jira (${ticket.externalKey}). Assignee: ${ticket.assignee}.`
      : `Imported from Jira (${ticket.externalKey}).`;

    let conflicts: TicketFieldConflict[] = [];

    if (existing) {
      const remote: TicketMergeSnapshot = { title: ticket.title, status: mapStatus(ticket.status), priority: mapPriority(ticket.priority) };
      const merge = mergeTicketFields(
        { title: existing.title, status: existing.status, priority: existing.priority },
        remote,
        existing.externalSyncBase as TicketMergeSnapshot | null,
      );
      conflicts = merge.conflicts;
      for (const field of Object.keys(merge.patch) as (keyof TicketMergeSnapshot)[]) {
        changes.push({ field, label: FIELD_LABELS[field], from: existing[field], to: merge.patch[field] as string });
      }
      if (existing.description !== description) {
        changes.push({ field: "description", label: "Description", from: existing.description, to: description });
      }

      const newLabels = ticketLabels(ticket);
      if (newLabels.length > 0 && joinOrNone([...existing.labels].sort()) !== joinOrNone([...newLabels].sort())) {
        changes.push({ field: "labels", label: "Labels", from: joinOrNone(existing.labels), to: joinOrNone(newLabels) });
      }

      if (ticket.dueDate && existing.dueDate !== ticket.dueDate) {
        changes.push({ field: "dueDate", label: "Due Date", from: existing.dueDate || "(none)", to: ticket.dueDate });
      }

      if (ticket.storyPoints !== undefined && existing.storyPoints !== ticket.storyPoints) {
        changes.push({
          field: "storyPoints",
          label: "Story Points",
          from: existing.storyPoints !== null ? String(existing.storyPoints) : "(none)",
          to: String(ticket.storyPoints),
        });
      }

      if (ticket.sprintId?.trim()) {
        const names = await planningGroupNamesById(db, existing.cycleId ? [existing.cycleId] : []);
        const currentName = existing.cycleId ? (names.get(existing.cycleId) ?? "(unknown)") : "(none)";
        const newName = ticket.sprintId.trim();
        if (currentName !== newName) changes.push({ field: "cycle", label: "Sprint → Cycle", from: currentName, to: newName });
      }

      if (ticket.fixVersions?.length) {
        const names = await planningGroupNamesById(db, existing.moduleIds);
        const currentNames = existing.moduleIds.map((id) => names.get(id) ?? "(unknown)").sort();
        const newNames = [...new Set(ticket.fixVersions.map((v) => v.trim()).filter(Boolean))].sort();
        if (joinOrNone(currentNames) !== joinOrNone(newNames)) {
          changes.push({ field: "modules", label: "Fix Version/s → Modules", from: joinOrNone(currentNames), to: joinOrNone(newNames) });
        }
      }
    } else {
      changes.push({ field: "title", label: "Title", from: "(none — new work item)", to: ticket.title });
      changes.push({ field: "status", label: "Status", from: "(none — new work item)", to: mapStatus(ticket.status) });
      changes.push({ field: "priority", label: "Priority", from: "(none — new work item)", to: mapPriority(ticket.priority) });
      changes.push({ field: "description", label: "Description", from: "(none — new work item)", to: description });
      const newLabels = ticketLabels(ticket);
      if (newLabels.length > 0) changes.push({ field: "labels", label: "Labels", from: "(none)", to: joinOrNone(newLabels) });
      if (ticket.dueDate) changes.push({ field: "dueDate", label: "Due Date", from: "(none)", to: ticket.dueDate });
      if (ticket.storyPoints !== undefined) changes.push({ field: "storyPoints", label: "Story Points", from: "(none)", to: String(ticket.storyPoints) });
      if (ticket.sprintId?.trim()) changes.push({ field: "cycle", label: "Sprint → Cycle", from: "(none)", to: ticket.sprintId.trim() });
      if (ticket.fixVersions?.length) {
        changes.push({
          field: "modules",
          label: "Fix Version/s → Modules",
          from: "(none)",
          to: joinOrNone([...new Set(ticket.fixVersions.map((v) => v.trim()).filter(Boolean))].sort()),
        });
      }
    }

    results.push({
      ticketId: ticket.id,
      externalKey: ticket.externalKey,
      action: existing ? "update" : "create",
      workItemId: existing?.id,
      changes,
      conflicts,
    });
  }

  return results;
}

/**
 * Converts a user-selected set of Jira tickets (`tickets`) into real platform work items — a
 * deliberate action from the "Jira data" dialog (select rows, hit Convert), not automatic on
 * import/sync, since not every synced Jira issue necessarily belongs on this app's board. Idempotent —
 * matched on (externalProvider, externalKey), so re-converting an already-converted ticket updates its
 * work item rather than creating a duplicate.
 *
 * `targetProjectId`, when given, is the admin-ui project the user was viewing when they hit Convert —
 * new work items land there so they show up immediately on that project's Work Items screen. Without
 * it, falls back to auto-creating/matching a project by Jira project key (`code`), which put converted
 * items in a project the user wasn't looking at and made them appear to "disappear".
 */
export async function convertTicketsToWorkItems(
  db: WorkflowDb,
  ticketsToConvert: NormalizedTicket[],
  targetProjectId?: string,
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const ticket of ticketsToConvert) {
    const project = targetProjectId
      ? { id: targetProjectId }
      : await ensureProject(db, ticket.projectKey);
    const [existing] = await db
      .select({
        id: workItems.id,
        projectId: workItems.projectId,
        title: workItems.title,
        status: workItems.status,
        priority: workItems.priority,
        externalSyncBase: workItems.externalSyncBase,
      })
      .from(workItems)
      .where(and(eq(workItems.externalProvider, ticket.provider), eq(workItems.externalKey, ticket.externalKey)));

    const description = ticket.assignee
      ? `Imported from Jira (${ticket.externalKey}). Assignee: ${ticket.assignee}.`
      : `Imported from Jira (${ticket.externalKey}).`;

    if (existing) {
      const remote: TicketMergeSnapshot = {
        title: ticket.title,
        status: mapStatus(ticket.status),
        priority: mapPriority(ticket.priority),
      };
      const merge = mergeTicketFields(
        { title: existing.title, status: existing.status, priority: existing.priority },
        remote,
        existing.externalSyncBase as TicketMergeSnapshot | null,
      );

      // Re-converting moves the item to `targetProjectId` too, not just refreshing its fields — earlier
      // conversions could have landed under an auto-created project (before targetProjectId existed, or
      // when the user picked a different project that time), which otherwise leaves it stuck out of view.
      // `number` is only unique per project (work_items_project_number), so moving projects means
      // allocating a fresh number in the destination rather than carrying the old one over.
      let movePatch = {};
      if (targetProjectId && targetProjectId !== existing.projectId) {
        const [updatedProject] = await db
          .update(projects)
          .set({ nextNumber: sql`${projects.nextNumber} + 1` })
          .where(eq(projects.id, targetProjectId))
          .returning();
        movePatch = { projectId: targetProjectId, number: updatedProject.nextNumber - 1 };
      }

      const finalProjectId = targetProjectId && targetProjectId !== existing.projectId ? targetProjectId : existing.projectId;
      const { cycleId, moduleIds } = await mapTicketToPlanningGroups(db, finalProjectId, ticket);
      const labels = ticketLabels(ticket);

      await db
        .update(workItems)
        .set({
          ...merge.patch,
          description,
          externalSyncBase: merge.newBase,
          ...movePatch,
          ...(cycleId ? { cycleId } : {}),
          ...(moduleIds.length > 0 ? { moduleIds } : {}),
          ...(labels.length > 0 ? { labels } : {}),
          ...(ticket.dueDate ? { dueDate: ticket.dueDate } : {}),
          ...(ticket.storyPoints !== undefined ? { storyPoints: ticket.storyPoints } : {}),
          updatedAt: new Date(),
        })
        .where(eq(workItems.id, existing.id));

      // Fully replace this work item's conflict set with what this run found — a field that resolved
      // itself (e.g. the app was edited back to match Jira) shouldn't leave a stale conflict row behind.
      await db.delete(ticketSyncConflicts).where(eq(ticketSyncConflicts.workItemId, existing.id));
      if (merge.conflicts.length > 0) {
        await db.insert(ticketSyncConflicts).values(
          merge.conflicts.map((c) => ({
            id: crypto.randomUUID(),
            workItemId: existing.id,
            field: c.field,
            appValue: c.appValue,
            jiraValue: c.jiraValue,
          })),
        );
      }

      updated += 1;
      continue;
    }

    const [updatedProject] = await db
      .update(projects)
      .set({ nextNumber: sql`${projects.nextNumber} + 1` })
      .where(eq(projects.id, project.id))
      .returning();
    const number = updatedProject.nextNumber - 1;

    const firstSyncBase: TicketMergeSnapshot = {
      title: ticket.title,
      status: mapStatus(ticket.status),
      priority: mapPriority(ticket.priority),
    };

    const { cycleId, moduleIds } = await mapTicketToPlanningGroups(db, project.id, ticket);

    await db.insert(workItems).values({
      id: crypto.randomUUID(),
      projectId: project.id,
      number,
      externalProvider: ticket.provider,
      externalKey: ticket.externalKey,
      description,
      ...firstSyncBase,
      externalSyncBase: firstSyncBase,
      cycleId: cycleId ?? "",
      moduleIds,
      labels: ticketLabels(ticket),
      dueDate: ticket.dueDate ?? "",
      storyPoints: ticket.storyPoints,
    });
    created += 1;
  }

  return { created, updated };
}
