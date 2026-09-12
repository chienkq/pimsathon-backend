import {
  executeWorkflow,
  type AiAgentLlmService,
  type AlertStoreService,
  type AnalysisResultStoreService,
  type TicketStoreService,
  type GitCacheStoreService,
  type GitClientService,
  type LocalGitClientService,
  type JiraClientService,
  type PlanningGroupStoreService,
  type WebhookRequestPayload,
  type WidgetStoreService,
  type WorkflowDefinition,
  type WorkflowExecutionResult,
  type WorkItemStoreService,
} from "@chienkq/workflow-core";
import { connectorStatus, workflowRuns, workflows, type WorkflowDb } from "@chienkq/workflow-db";
import { eq } from "drizzle-orm";

/** A registered workflow's source: either a fixed definition, or a factory re-run before every
 *  scheduled tick (used by W3 GitHub Sync so a credential change in Settings → Integrations takes
 *  effect on the next run without a backend restart). */
export type WorkflowSource = WorkflowDefinition | (() => Promise<WorkflowDefinition>);

export async function resolveWorkflow(source: WorkflowSource): Promise<WorkflowDefinition> {
  return typeof source === "function" ? source() : source;
}

/** The full service bag, passed to every workflow run — a node just ignores the keys it doesn't ask for. */
export interface RunnerServices {
  jiraClient: JiraClientService;
  ticketStore: TicketStoreService;
  alertStore: AlertStoreService;
  workItemStore: WorkItemStoreService;
  widgetStore: WidgetStoreService;
  planningGroupStore: PlanningGroupStoreService;
  gitClient: GitClientService;
  localGitClient: LocalGitClientService;
  gitCacheStore: GitCacheStoreService;
  analysisResultStore: AnalysisResultStoreService;
  llmClient: AiAgentLlmService;
  /** Only set for a run triggered by a real inbound webhook call — see `/api/webhooks/:workflowId` in index.ts. */
  webhookRequest?: WebhookRequestPayload;
}

/**
 * Idempotent — call once at startup so `workflow_runs`'s FK to `workflows` always has a target row.
 * `isSystem: true` is only for the fixed set of built-in workflows registered in index.ts — it only
 * takes effect on first insert (`onConflictDoNothing`); a pre-existing row's flag is left as-is, since
 * the 0011 migration already backfilled `is_system` for their known ids.
 */
export async function ensureWorkflowRow(db: WorkflowDb, workflow: WorkflowDefinition, isSystem = false): Promise<void> {
  await db
    .insert(workflows)
    .values({
      id: workflow.id,
      name: workflow.name,
      definition: workflow as unknown as Record<string, unknown>,
      active: workflow.active,
      isSystem,
    })
    .onConflictDoNothing({ target: workflows.id });
}

export async function runWorkflow(
  db: WorkflowDb,
  workflow: WorkflowDefinition,
  services: RunnerServices,
  trigger: "schedule" | "webhook" | "manual",
  /** Only connector-sync workflows (e.g. W1 Jira Sync) touch `connector_status` — rule workflows like W11 don't. */
  connectorProvider?: string,
): Promise<WorkflowExecutionResult & { runId: string }> {
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

    if (connectorProvider) {
      await db
        .insert(connectorStatus)
        .values({ provider: connectorProvider, lastSyncAt: new Date(), lastSuccess: result.status === "success" })
        .onConflictDoUpdate({
          target: connectorStatus.provider,
          set: { lastSyncAt: new Date(), lastSuccess: result.status === "success", lastError: null },
        });
    }
    return { ...result, runId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(workflowRuns)
      .set({ status: "error", finishedAt: new Date(), error: message })
      .where(eq(workflowRuns.id, runId));
    if (connectorProvider) {
      await db
        .insert(connectorStatus)
        .values({ provider: connectorProvider, lastSyncAt: new Date(), lastSuccess: false, lastError: message })
        .onConflictDoUpdate({
          target: connectorStatus.provider,
          set: { lastSyncAt: new Date(), lastSuccess: false, lastError: message },
        });
    }
    throw error;
  }
}
