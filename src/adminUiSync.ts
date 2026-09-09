import type { PlanningGroupKind, WorkItemPriority, WorkItemStatus } from "@chienkq/workflow-core";
import { planningGroups, workItems, type WorkflowDb } from "@chienkq/workflow-db";
import { eq } from "drizzle-orm";

/**
 * The fields admin-ui itself owns and writes through. Deliberately excludes `cycleId`/`moduleIds` —
 * those are backend/workflow-managed (e.g. W10's milestone linkage) and admin-ui doesn't manage
 * cycles/modules against this backend yet, so a write from admin-ui must never clear them.
 */
export interface AdminUiWorkItemFields {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  assigneeId: string;
  labels: string[];
  startDate: string;
  dueDate: string;
}

/**
 * Upsert-by-id, scoped to admin-ui's own fields. admin-ui is authoritative for `id`/`number`
 * (assigned by its own local reducer — see domain/commands.ts) so this never generates its own;
 * it only mirrors whatever admin-ui already decided. On first write for a given id, `cycleId`/
 * `moduleIds` default empty; on every later write to the same id, they're left exactly as they were.
 */
export async function upsertWorkItemFromAdminUi(db: WorkflowDb, item: AdminUiWorkItemFields): Promise<void> {
  await db
    .insert(workItems)
    .values({ ...item, labels: [...item.labels], cycleId: "", moduleIds: [] })
    .onConflictDoUpdate({
      target: workItems.id,
      set: {
        title: item.title,
        description: item.description,
        status: item.status,
        priority: item.priority,
        assigneeId: item.assigneeId,
        labels: [...item.labels],
        startDate: item.startDate,
        dueDate: item.dueDate,
        updatedAt: new Date(),
      },
    });
}

export async function deleteWorkItemFromAdminUi(db: WorkflowDb, id: string): Promise<void> {
  await db.delete(workItems).where(eq(workItems.id, id));
}

/** admin-ui's `PlanningGroup` (cycles + modules) plus the `kind` discriminator that only exists on the backend row. */
export interface AdminUiPlanningGroupFields {
  id: string;
  projectId: string;
  kind: PlanningGroupKind;
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  leadId: string;
}

/** Upsert-by-id, same pattern as `upsertWorkItemFromAdminUi` — admin-ui owns `id`, this never generates its own. */
export async function upsertPlanningGroupFromAdminUi(db: WorkflowDb, group: AdminUiPlanningGroupFields): Promise<void> {
  await db
    .insert(planningGroups)
    .values(group)
    .onConflictDoUpdate({
      target: planningGroups.id,
      set: {
        name: group.name,
        description: group.description,
        startDate: group.startDate,
        endDate: group.endDate,
        leadId: group.leadId,
      },
    });
}

export async function deletePlanningGroupFromAdminUi(db: WorkflowDb, id: string): Promise<void> {
  await db.delete(planningGroups).where(eq(planningGroups.id, id));
}
