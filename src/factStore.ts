import type { FactStoreService, NormalizedWorkItemFact, StoredWorkItemFact, WorkItemFactFilter } from "@chienkq/workflow-core";
import { workItemFacts, type WorkflowDb } from "@chienkq/workflow-db";
import { and, eq, sql } from "drizzle-orm";

const FILTER_COLUMNS = {
  provider: workItemFacts.provider,
  projectKey: workItemFacts.projectKey,
  status: workItemFacts.status,
  priority: workItemFacts.priority,
  assignee: workItemFacts.assignee,
} as const;

/** Real Postgres-backed implementation of `services.factStore` for the `factUpsert` node. */
export function createFactStore(db: WorkflowDb): FactStoreService {
  return {
    async upsertWorkItems(facts: NormalizedWorkItemFact[]) {
      if (facts.length === 0) return;
      await Promise.all(
        facts.map((fact) =>
          db
            .insert(workItemFacts)
            .values({ id: crypto.randomUUID(), ...fact, syncedAt: new Date() })
            .onConflictDoUpdate({
              target: [workItemFacts.provider, workItemFacts.externalId],
              set: {
                externalKey: fact.externalKey,
                projectKey: fact.projectKey,
                title: fact.title,
                status: fact.status,
                priority: fact.priority,
                assignee: fact.assignee,
                storyPoints: fact.storyPoints,
                sprintId: fact.sprintId,
                raw: fact.raw,
                syncedAt: sql`now()`,
              },
            }),
        ),
      );
    },

    async queryWorkItems(filter: WorkItemFactFilter): Promise<StoredWorkItemFact[]> {
      const conditions = (Object.entries(filter) as [keyof WorkItemFactFilter, string | undefined][])
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => eq(FILTER_COLUMNS[key], value as string));

      const rows = await db
        .select()
        .from(workItemFacts)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      return rows.map((row) => ({
        ...row,
        priority: row.priority ?? undefined,
        assignee: row.assignee ?? undefined,
        storyPoints: row.storyPoints ?? undefined,
        sprintId: row.sprintId ?? undefined,
        syncedAt: row.syncedAt.toISOString(),
      }));
    },
  };
}
