import type { FactStoreService, NormalizedWorkItemFact } from "@chienkq/workflow-core";
import { workItemFacts, type WorkflowDb } from "@chienkq/workflow-db";
import { sql } from "drizzle-orm";

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
  };
}
