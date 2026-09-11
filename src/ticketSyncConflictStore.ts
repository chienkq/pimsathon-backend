import { ticketSyncConflicts, workItems, type WorkflowDb } from "@chienkq/workflow-db";
import { eq } from "drizzle-orm";

const STATUSES = ["Todo", "In Progress", "In Review", "Done", "Cancelled"] as const;
const PRIORITIES = ["Low", "Medium", "High", "Urgent"] as const;

/** Narrows the conflict's stored `jsonb` string back to the work item column's literal union —
 *  safe because it always originated from that same column (see `jiraTicketToWorkItem.ts`'s merge). */
function asStatus(value: string): (typeof STATUSES)[number] {
  return STATUSES.includes(value as (typeof STATUSES)[number]) ? (value as (typeof STATUSES)[number]) : "Todo";
}
function asPriority(value: string): (typeof PRIORITIES)[number] {
  return PRIORITIES.includes(value as (typeof PRIORITIES)[number]) ? (value as (typeof PRIORITIES)[number]) : "Medium";
}

export interface TicketSyncConflictView {
  id: string;
  workItemId: string;
  workItemKey: string;
  workItemTitle: string;
  field: "title" | "status" | "priority";
  appValue: string;
  jiraValue: string;
  createdAt: string;
}

/**
 * Reads/resolves the conflicts left behind by `convertTicketsToWorkItems`'s three-way merge (see
 * `jiraTicketToWorkItem.ts`) for the Jira Sync screen's "Resolve sync conflicts" card.
 */
export function createTicketSyncConflictStore(db: WorkflowDb) {
  return {
    async listByProject(projectId: string): Promise<TicketSyncConflictView[]> {
      const rows = await db
        .select({
          id: ticketSyncConflicts.id,
          workItemId: ticketSyncConflicts.workItemId,
          field: ticketSyncConflicts.field,
          appValue: ticketSyncConflicts.appValue,
          jiraValue: ticketSyncConflicts.jiraValue,
          createdAt: ticketSyncConflicts.createdAt,
          projectId: workItems.projectId,
          number: workItems.number,
          workItemTitle: workItems.title,
        })
        .from(ticketSyncConflicts)
        .innerJoin(workItems, eq(ticketSyncConflicts.workItemId, workItems.id))
        .where(eq(workItems.projectId, projectId));

      return rows.map((row) => ({
        id: row.id,
        workItemId: row.workItemId,
        workItemKey: `#${row.number}`,
        workItemTitle: row.workItemTitle,
        field: row.field as "title" | "status" | "priority",
        appValue: row.appValue,
        jiraValue: row.jiraValue,
        createdAt: row.createdAt.toISOString(),
      }));
    },

    /** `"app"` keeps the work item's current value (just clears the conflict); `"jira"` overwrites
     *  the work item field with the Jira value. Either way, `externalSyncBase` for that field is set
     *  to the chosen value so the next sync doesn't immediately re-flag the same divergence. */
    async resolve(id: string, choice: "app" | "jira"): Promise<void> {
      const [conflict] = await db.select().from(ticketSyncConflicts).where(eq(ticketSyncConflicts.id, id));
      if (!conflict) throw new Error("Unknown conflict.");

      const [workItem] = await db.select().from(workItems).where(eq(workItems.id, conflict.workItemId));
      if (!workItem) throw new Error("Work item for this conflict no longer exists.");

      const resolvedValue = choice === "jira" ? conflict.jiraValue : conflict.appValue;
      const base = workItem.externalSyncBase ?? { title: workItem.title, status: workItem.status, priority: workItem.priority };

      const fieldPatch =
        conflict.field === "title"
          ? { title: resolvedValue }
          : conflict.field === "status"
            ? { status: asStatus(resolvedValue) }
            : { priority: asPriority(resolvedValue) };
      const newBase =
        conflict.field === "title"
          ? { ...base, title: resolvedValue }
          : conflict.field === "status"
            ? { ...base, status: asStatus(resolvedValue) }
            : { ...base, priority: asPriority(resolvedValue) };

      await db
        .update(workItems)
        .set({
          ...(choice === "jira" ? fieldPatch : {}),
          externalSyncBase: newBase,
          updatedAt: new Date(),
        })
        .where(eq(workItems.id, conflict.workItemId));

      await db.delete(ticketSyncConflicts).where(eq(ticketSyncConflicts.id, id));
    },
  };
}

export type TicketSyncConflictStore = ReturnType<typeof createTicketSyncConflictStore>;
