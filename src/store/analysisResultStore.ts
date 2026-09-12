import type { AnalysisResult, AnalysisResultStoreService, AnalysisSubjectType, StoredAnalysisResult } from "@chienkq/workflow-core";
import { analysisResults, type WorkflowDb } from "@chienkq/workflow-db";
import { and, desc, eq, inArray } from "drizzle-orm";

type AnalysisResultRow = typeof analysisResults.$inferSelect;

function toDomain(row: AnalysisResultRow): StoredAnalysisResult {
  return {
    id: row.id,
    subjectType: row.subjectType as AnalysisSubjectType,
    subjectId: row.subjectId,
    status: row.status as StoredAnalysisResult["status"],
    healthScore: row.healthScore,
    summary: row.summary,
    risks: row.risks as unknown as StoredAnalysisResult["risks"],
    completionDate: row.completionDate ?? undefined,
    recommendedActions: row.recommendedActions,
    needsAlert: row.needsAlert,
    alertSeverity: row.alertSeverity ?? undefined,
    analyzedAt: row.analyzedAt.toISOString(),
  };
}

/** Real Postgres-backed implementation of `services.analysisResultStore` for the `analysisResultSave`/`analysisResultQuery` nodes (Analyze Cycle, Analyze Module). */
export function createAnalysisResultStore(db: WorkflowDb): AnalysisResultStoreService {
  return {
    async insert(result: AnalysisResult) {
      const [row] = await db
        .insert(analysisResults)
        .values({ id: crypto.randomUUID(), ...result, risks: result.risks as unknown as Record<string, unknown>[] })
        .returning();
      return toDomain(row);
    },

    async queryLatest(subjectType: AnalysisSubjectType, subjectId: string, limit: number) {
      const rows = await db
        .select()
        .from(analysisResults)
        .where(and(eq(analysisResults.subjectType, subjectType), eq(analysisResults.subjectId, subjectId)))
        .orderBy(desc(analysisResults.analyzedAt))
        .limit(limit);
      return rows.map(toDomain);
    },
  };
}

/**
 * The latest `analysis_results` row per subject, for a batch of subject ids of the same type (e.g.
 * every cycle or module in a project) — one query instead of N, used by the Project Health page.
 */
export async function queryLatestForSubjects(
  db: WorkflowDb,
  subjectType: AnalysisSubjectType,
  subjectIds: string[]
): Promise<StoredAnalysisResult[]> {
  if (subjectIds.length === 0) return [];
  const rows = await db
    .select()
    .from(analysisResults)
    .where(and(eq(analysisResults.subjectType, subjectType), inArray(analysisResults.subjectId, subjectIds)))
    .orderBy(desc(analysisResults.analyzedAt));
  const latestBySubject = new Map<string, AnalysisResultRow>();
  for (const row of rows) {
    if (!latestBySubject.has(row.subjectId)) latestBySubject.set(row.subjectId, row);
  }
  return [...latestBySubject.values()].map(toDomain);
}
