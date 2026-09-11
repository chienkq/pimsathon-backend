import type { NormalizedTicket } from "@chienkq/workflow-core";
import { projects, workItems, type WorkflowDb } from "@chienkq/workflow-db";
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
      .select({ id: workItems.id, projectId: workItems.projectId })
      .from(workItems)
      .where(and(eq(workItems.externalProvider, ticket.provider), eq(workItems.externalKey, ticket.externalKey)));

    const patch = {
      title: ticket.title,
      status: mapStatus(ticket.status),
      priority: mapPriority(ticket.priority),
      description: ticket.assignee ? `Imported from Jira (${ticket.externalKey}). Assignee: ${ticket.assignee}.` : `Imported from Jira (${ticket.externalKey}).`,
    };

    if (existing) {
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
        .set({ ...patch, ...movePatch, updatedAt: new Date() })
        .where(eq(workItems.id, existing.id));
      updated += 1;
      continue;
    }

    const [updatedProject] = await db
      .update(projects)
      .set({ nextNumber: sql`${projects.nextNumber} + 1` })
      .where(eq(projects.id, project.id))
      .returning();
    const number = updatedProject.nextNumber - 1;

    await db.insert(workItems).values({
      id: crypto.randomUUID(),
      projectId: project.id,
      number,
      externalProvider: ticket.provider,
      externalKey: ticket.externalKey,
      ...patch,
    });
    created += 1;
  }

  return { created, updated };
}
