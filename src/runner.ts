import { executeWorkflow, type FactStoreService, type JiraClientService, type WorkflowDefinition } from "@chienkq/workflow-core";
import { connectorStatus, workflowRuns, workflows, type WorkflowDb } from "@chienkq/workflow-db";
import { eq } from "drizzle-orm";

export interface RunnerServices {
  jiraClient: JiraClientService;
  factStore: FactStoreService;
}

/** Idempotent — call once at startup so `workflow_runs`'s FK to `workflows` always has a target row. */
export async function ensureWorkflowRow(db: WorkflowDb, workflow: WorkflowDefinition): Promise<void> {
  await db
    .insert(workflows)
    .values({
      id: workflow.id,
      name: workflow.name,
      definition: workflow as unknown as Record<string, unknown>,
      active: workflow.active,
    })
    .onConflictDoNothing({ target: workflows.id });
}

export async function runWorkflow(
  db: WorkflowDb,
  workflow: WorkflowDefinition,
  services: RunnerServices,
  trigger: "schedule" | "webhook" | "manual",
): Promise<"success" | "error"> {
  const runId = crypto.randomUUID();
  await db.insert(workflowRuns).values({ id: runId, workflowId: workflow.id, status: "running", trigger });

  try {
    const result = await executeWorkflow(workflow, { services: services as unknown as Record<string, unknown> });
    await db
      .update(workflowRuns)
      .set({
        status: result.status,
        finishedAt: new Date(),
        output: result.nodeResults as unknown as Record<string, unknown>,
      })
      .where(eq(workflowRuns.id, runId));

    await db
      .insert(connectorStatus)
      .values({ provider: "jira", lastSyncAt: new Date(), lastSuccess: result.status === "success" })
      .onConflictDoUpdate({
        target: connectorStatus.provider,
        set: { lastSyncAt: new Date(), lastSuccess: result.status === "success", lastError: null },
      });
    return result.status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(workflowRuns)
      .set({ status: "error", finishedAt: new Date(), error: message })
      .where(eq(workflowRuns.id, runId));
    await db
      .insert(connectorStatus)
      .values({ provider: "jira", lastSyncAt: new Date(), lastSuccess: false, lastError: message })
      .onConflictDoUpdate({ target: connectorStatus.provider, set: { lastSyncAt: new Date(), lastSuccess: false, lastError: message } });
    throw error;
  }
}
