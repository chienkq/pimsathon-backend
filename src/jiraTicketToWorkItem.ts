import type { NormalizedTicket } from "@chienkq/workflow-core";
import { projects, ticketSyncConflicts, workItems, type WorkflowDb } from "@chienkq/workflow-db";
import { and, eq, sql } from "drizzle-orm";

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

interface TicketFieldConflict {
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
      await db
        .update(workItems)
        .set({ ...merge.patch, description, externalSyncBase: merge.newBase, ...movePatch, updatedAt: new Date() })
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

    await db.insert(workItems).values({
      id: crypto.randomUUID(),
      projectId: project.id,
      number,
      externalProvider: ticket.provider,
      externalKey: ticket.externalKey,
      description,
      ...firstSyncBase,
      externalSyncBase: firstSyncBase,
    });
    created += 1;
  }

  return { created, updated };
}
