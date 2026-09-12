import type { PlatformWorkItem, WorkItemInput, WorkItemListFilter, WorkItemStatus, WorkItemStoreService } from "@chienkq/workflow-core";
import { projects, workItems, type WorkflowDb } from "@chienkq/workflow-db";
import { and, eq, sql } from "drizzle-orm";

type WorkItemRow = typeof workItems.$inferSelect;

function toDomain(row: WorkItemRow, projectCode: string): PlatformWorkItem {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    projectCode,
    key: `${projectCode}-${row.number}`,
    title: row.title,
    description: row.description,
    status: row.status as PlatformWorkItem["status"],
    priority: row.priority as PlatformWorkItem["priority"],
    assigneeId: row.assigneeId,
    labels: row.labels,
    startDate: row.startDate,
    dueDate: row.dueDate,
    cycleId: row.cycleId,
    moduleIds: row.moduleIds,
    storyPoints: row.storyPoints ?? undefined,
    externalProvider: row.externalProvider ?? undefined,
    externalKey: row.externalKey ?? undefined,
    aiNote: row.aiNote ?? undefined,
  };
}

const FILTER_COLUMNS = {
  projectId: workItems.projectId,
  status: workItems.status,
  priority: workItems.priority,
  externalProvider: workItems.externalProvider,
  externalKey: workItems.externalKey,
} as const;

/**
 * Real Postgres-backed implementation of `services.workItemStore` for the `workItem` (platform)
 * node — mirrors the shape and rules of `apps/admin-ui`'s own `domain/commands.ts` "save-work-item"
 * / "move-work-item" / "delete-work-item" handlers (per-project sequential numbering included), but
 * against this backend's own tables rather than admin-ui's in-browser demo state. See schema.ts's
 * `workItems`/`projects` comment for why there's no separate normalize/sync step for this data.
 */
export function createWorkItemStore(db: WorkflowDb): WorkItemStoreService {
  async function getProjectCode(projectId: string): Promise<string> {
    const [project] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw new Error(`Project ${projectId} not found.`);
    return project.code;
  }

  return {
    async list(filter: WorkItemListFilter) {
      const conditions = (Object.entries(filter) as [keyof WorkItemListFilter, string | undefined][])
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => eq(FILTER_COLUMNS[key], value as string));

      const rows = await db
        .select({ item: workItems, projectCode: projects.code })
        .from(workItems)
        .innerJoin(projects, eq(workItems.projectId, projects.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      return rows.map(({ item, projectCode }) => toDomain(item, projectCode));
    },

    async get(id: string) {
      const [row] = await db
        .select({ item: workItems, projectCode: projects.code })
        .from(workItems)
        .innerJoin(projects, eq(workItems.projectId, projects.id))
        .where(eq(workItems.id, id));
      return row ? toDomain(row.item, row.projectCode) : undefined;
    },

    async create(input: WorkItemInput) {
      // Atomic per-project numbering, matching admin-ui's `project.nextNumber++` (domain/commands.ts).
      const [updatedProject] = await db
        .update(projects)
        .set({ nextNumber: sql`${projects.nextNumber} + 1` })
        .where(eq(projects.id, input.projectId))
        .returning();
      if (!updatedProject) throw new Error(`Project ${input.projectId} not found.`);
      const number = updatedProject.nextNumber - 1;

      const [row] = await db
        .insert(workItems)
        .values({ id: crypto.randomUUID(), number, ...input })
        .returning();
      return toDomain(row, updatedProject.code);
    },

    async update(id: string, patch: Partial<WorkItemInput>) {
      const [row] = await db
        .update(workItems)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(workItems.id, id))
        .returning();
      if (!row) throw new Error(`Work item ${id} not found.`);
      return toDomain(row, await getProjectCode(row.projectId));
    },

    async moveStatus(id: string, status: WorkItemStatus) {
      const [row] = await db
        .update(workItems)
        .set({ status, updatedAt: new Date() })
        .where(eq(workItems.id, id))
        .returning();
      if (!row) throw new Error(`Work item ${id} not found.`);
      return toDomain(row, await getProjectCode(row.projectId));
    },

    async remove(id: string) {
      await db.delete(workItems).where(eq(workItems.id, id));
    },
  };
}
