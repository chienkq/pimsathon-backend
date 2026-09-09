import type { PlanningGroupInput, PlanningGroupListFilter, PlanningGroupStoreService, PlatformPlanningGroup } from "@chienkq/workflow-core";
import { planningGroups, type WorkflowDb } from "@chienkq/workflow-db";
import { and, eq } from "drizzle-orm";

type PlanningGroupRow = typeof planningGroups.$inferSelect;

function toDomain(row: PlanningGroupRow): PlatformPlanningGroup {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as PlatformPlanningGroup["kind"],
    name: row.name,
    description: row.description,
    startDate: row.startDate,
    endDate: row.endDate,
    leadId: row.leadId,
  };
}

const FILTER_COLUMNS = {
  projectId: planningGroups.projectId,
  kind: planningGroups.kind,
} as const;

/** Real Postgres-backed implementation of `services.planningGroupStore` for the `planningGroup` (platform) node. */
export function createPlanningGroupStore(db: WorkflowDb): PlanningGroupStoreService {
  return {
    async list(filter: PlanningGroupListFilter) {
      const conditions = (Object.entries(filter) as [keyof PlanningGroupListFilter, string | undefined][])
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => eq(FILTER_COLUMNS[key], value as string));

      const rows = await db
        .select()
        .from(planningGroups)
        .where(conditions.length > 0 ? and(...conditions) : undefined);
      return rows.map(toDomain);
    },

    async get(id: string) {
      const [row] = await db.select().from(planningGroups).where(eq(planningGroups.id, id));
      return row ? toDomain(row) : undefined;
    },

    async create(input: PlanningGroupInput) {
      const [row] = await db
        .insert(planningGroups)
        .values({ id: crypto.randomUUID(), ...input })
        .returning();
      return toDomain(row);
    },

    async update(id: string, patch: Partial<PlanningGroupInput>) {
      const [row] = await db.update(planningGroups).set(patch).where(eq(planningGroups.id, id)).returning();
      if (!row) throw new Error(`Planning group ${id} not found.`);
      return toDomain(row);
    },

    async remove(id: string) {
      await db.delete(planningGroups).where(eq(planningGroups.id, id));
    },
  };
}
