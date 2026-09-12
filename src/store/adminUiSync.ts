import type { PlanningGroupKind, WorkItemPriority, WorkItemStatus } from "@chienkq/workflow-core";
import { planningGroups, workItems, type WorkflowDb } from "@chienkq/workflow-db";
import { eq } from "drizzle-orm";

/**
 * The fields admin-ui itself owns and writes through, including `cycleId`/`moduleIds` — admin-ui's
 * own Planning UI (Sprints/Modules) assigns these directly, same as a workflow's Update Work Item
 * node does (see workflow-core's nodeTypes/workItem.ts): both write the same columns, last write wins.
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
  cycleId: string;
  moduleIds: string[];
  /** Free-text scratchpad AI/humans write to so future AI runs can read a work item's context fast. */
  aiNote: string;
}

/**
 * Upsert-by-id, scoped to admin-ui's own fields. admin-ui is authoritative for `id`/`number`
 * (assigned by its own local reducer — see domain/commands.ts) so this never generates its own;
 * it only mirrors whatever admin-ui already decided.
 */
export async function upsertWorkItemFromAdminUi(db: WorkflowDb, item: AdminUiWorkItemFields): Promise<void> {
  await db
    .insert(workItems)
    .values({ ...item, labels: [...item.labels], moduleIds: [...item.moduleIds] })
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
        cycleId: item.cycleId,
        moduleIds: [...item.moduleIds],
        aiNote: item.aiNote,
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
