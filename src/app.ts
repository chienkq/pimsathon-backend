import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { createDb } from "@chienkq/workflow-db";
import { createAgentToolStore } from "./store/agentToolStore.js";
import { createAiAgentStore } from "./store/aiAgentStore.js";
import { createAlertStore } from "./store/alertStore.js";
import { createAnalysisResultStore } from "./store/analysisResultStore.js";
import { createAppSettingsStore } from "./store/appSettingsStore.js";
import { createCodeIndexStore } from "./store/codeIndexStore.js";
import { createCodeSearchSettingsStore, type CodeSearchSettingsStore } from "./store/codeSearchSettingsStore.js";
import { createCredentialStore, type CredentialStore } from "./store/credentialStore.js";
import { createTicketStore } from "./store/ticketStore.js";
import { createTicketSyncConflictStore, type TicketSyncConflictStore } from "./store/ticketSyncConflictStore.js";
import { createGitCacheStore } from "./store/gitCacheStore.js";
import { createLlmConfigStore, type LlmConfigStore } from "./store/llmConfigStore.js";
import { createPlanningGroupStore } from "./store/planningGroupStore.js";
import { createWidgetStore } from "./store/widgetStore.js";
import { createWorkItemStore } from "./store/workItemStore.js";
import { createWorkflowStore, type WorkflowStore } from "./store/workflowStore.js";
import { createGitClientFromCredentials } from "./integrations/github/githubClient.js";
import { createJiraClientFromCredentials } from "./integrations/jira/jiraClient.js";
import { createJiraImportJobStore, type JiraImportJobStore } from "./integrations/jira/jiraImportJobs.js";
import { createLocalGitClientFromCredentials } from "./integrations/localGit/localGitClient.js";
import { createChunkedUploadStore, type ChunkedUploadStore } from "./lib/chunkedUploads.js";
import { createAgentClient, createLlmClient } from "./services/agents/llmClient.js";
import { createCodeIndexService } from "./services/codeSearch/codeIndexService.js";
import { ensureWorkflowRow, resolveWorkflow, type RunnerServices } from "./services/workflow/runner.js";
import { scheduleWorkflow } from "./services/workflow/scheduler.js";
import { seedPlatformData } from "./seeds/seedPlatformData.js";
import {
  ALERT_ENGINE_WORKFLOW_ID,
  buildAlertEngineWorkflow,
  buildBugMetricsWorkflow,
  buildGitHubSyncWorkflowFromCredentials,
  buildJiraSyncWorkflow,
  buildMilestoneTrackerWorkflow,
  buildTeamWorkloadWorkflow,
  BUG_METRICS_WORKFLOW_ID,
  GITHUB_SYNC_WORKFLOW_ID,
  JIRA_SYNC_WORKFLOW_ID,
  MILESTONE_TRACKER_WORKFLOW_ID,
  TEAM_WORKLOAD_WORKFLOW_ID,
} from "./seeds/seedWorkflow.js";
import {
  ANALYZE_CYCLE_WORKFLOW_ID,
  ANALYZE_MODULE_WORKFLOW_ID,
  ANALYZE_WORKITEM_HEALTH_WORKFLOW_ID,
  ANALYZE_WORKITEM_LOCAL_SOURCE_WORKFLOW_ID,
  ANALYZE_WORKITEM_AUTHENTICITY_WORKFLOW_ID,
  buildAnalyzeCycleWorkflow,
  buildAnalyzeModuleWorkflow,
  buildAnalyzeWorkItemHealthWorkflow,
  buildAnalyzeWorkItemLocalSourceWorkflow,
  buildAnalyzeWorkItemAuthenticityWorkflow,
} from "./seeds/seedAnalyzeWorkflows.js";
import { seedAuthenticityAgent } from "./seeds/seedAuthenticityAgent.js";
import { env } from "./config/env.js";

import { registerHealthRoutes } from "./routes/health.js";
import { registerNodeTypeRoutes } from "./routes/nodeTypes.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerMemberRoutes } from "./routes/members.js";
import { registerWorkItemRoutes } from "./routes/workItems.js";
import { registerPlanningGroupRoutes } from "./routes/planningGroups.js";
import { registerWidgetRoutes } from "./routes/widgets.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerLlmConfigRoutes } from "./routes/llmConfigs.js";
import { registerAiAgentRoutes } from "./routes/aiAgents.js";
import { registerAgentToolRoutes } from "./routes/agentTools.js";
import { registerLocalGitRoutes } from "./routes/localGit.js";
import { registerTicketRoutes } from "./routes/tickets.js";

/**
 * Every singleton/store a route module might need — built once in `buildApp()` and threaded into
 * each `register*Routes(app, ctx)` call, replacing what used to be plain module-scope `const`s in
 * `index.ts`.
 */
export interface BackendContext {
  db: ReturnType<typeof createDb>;
  services: RunnerServices;
  workflowStore: WorkflowStore;
  credentialStore: CredentialStore;
  llmConfigStore: LlmConfigStore;
  aiAgentStore: ReturnType<typeof createAiAgentStore>;
  agentToolStore: ReturnType<typeof createAgentToolStore>;
  appSettingsStore: ReturnType<typeof createAppSettingsStore>;
  jiraImportJobs: JiraImportJobStore;
  chunkedUploads: ChunkedUploadStore;
  ticketSyncConflictStore: TicketSyncConflictStore;
  codeSearchSettingsStore: CodeSearchSettingsStore;
  codeIndexStore: ReturnType<typeof createCodeIndexStore>;
  registeredWorkflows: ReturnType<typeof buildRegisteredWorkflows>;
}

function buildRegisteredWorkflows(
  credentialStore: CredentialStore,
  authenticityAgentId: string
) {
  /** Registered workflows, keyed by id — `connectorProvider` is set only for connector-sync workflows (W1, W3), not rule/metric workflows (W8-W10, W11). */
  return {
    [JIRA_SYNC_WORKFLOW_ID]: { workflow: buildJiraSyncWorkflow(), cron: "*/15 * * * *", connectorProvider: "jira" },
    [GITHUB_SYNC_WORKFLOW_ID]: {
      // Rebuilt fresh on every scheduled tick from the credentials table (see scheduleWorkflow below),
      // not once at startup — so a reconfigure in Settings → Integrations takes effect on the next run.
      workflow: () => buildGitHubSyncWorkflowFromCredentials(credentialStore),
      cron: "*/15 * * * *",
      connectorProvider: "github",
    },
    [ALERT_ENGINE_WORKFLOW_ID]: {
      workflow: buildAlertEngineWorkflow(),
      cron: "0 */2 * * *",
      connectorProvider: undefined,
    },
    [TEAM_WORKLOAD_WORKFLOW_ID]: {
      workflow: buildTeamWorkloadWorkflow(),
      cron: "0 */2 * * *",
      connectorProvider: undefined,
    },
    [BUG_METRICS_WORKFLOW_ID]: { workflow: buildBugMetricsWorkflow(), cron: "0 */2 * * *", connectorProvider: undefined },
    [MILESTONE_TRACKER_WORKFLOW_ID]: {
      workflow: buildMilestoneTrackerWorkflow(),
      cron: "0 */2 * * *",
      connectorProvider: undefined,
    },
    [ANALYZE_CYCLE_WORKFLOW_ID]: {
      workflow: buildAnalyzeCycleWorkflow(),
      cron: "0 */2 * * *",
      connectorProvider: undefined,
    },
    [ANALYZE_MODULE_WORKFLOW_ID]: {
      workflow: buildAnalyzeModuleWorkflow(),
      cron: "0 */2 * * *",
      connectorProvider: undefined,
    },
    [ANALYZE_WORKITEM_HEALTH_WORKFLOW_ID]: {
      workflow: buildAnalyzeWorkItemHealthWorkflow(),
      cron: "0 */2 * * *",
      connectorProvider: undefined,
    },
    [ANALYZE_WORKITEM_LOCAL_SOURCE_WORKFLOW_ID]: {
      workflow: buildAnalyzeWorkItemLocalSourceWorkflow(),
      cron: "0 */2 * * *",
      connectorProvider: undefined,
    },
    [ANALYZE_WORKITEM_AUTHENTICITY_WORKFLOW_ID]: {
      workflow: buildAnalyzeWorkItemAuthenticityWorkflow(authenticityAgentId),
      cron: "0 */2 * * *",
      connectorProvider: undefined,
    },
  } as const;
}

export async function buildApp(): Promise<FastifyInstance> {
  const db = createDb(env.databaseUrl);
  const workflowStore = createWorkflowStore(db);
  const credentialStore = createCredentialStore(db);
  const llmConfigStore = createLlmConfigStore(db);
  const aiAgentStore = createAiAgentStore(db);
  const agentToolStore = createAgentToolStore(db);
  const appSettingsStore = createAppSettingsStore(db);
  const jiraImportJobs = createJiraImportJobStore();
  const chunkedUploads = createChunkedUploadStore();
  const ticketSyncConflictStore = createTicketSyncConflictStore(db);
  // Full-typed (getFileSnippet + listBranches/getStatus/getLog/getConfigList) — also used directly by
  // the `/api/local-git/*` routes below, not just as the narrower `LocalGitClientService` the `git`
  // node asks for.
  const localGitClient = createLocalGitClientFromCredentials(credentialStore);
  const codeSearchSettingsStore = createCodeSearchSettingsStore(appSettingsStore);
  const codeIndexStore = createCodeIndexStore(db);
  const codeIndexService = createCodeIndexService({ localGitClient, codeSearchSettingsStore, codeIndexStore, llmConfigStore });
  const services: RunnerServices = {
    jiraClient: createJiraClientFromCredentials(credentialStore),
    ticketStore: createTicketStore(db),
    alertStore: createAlertStore(db),
    workItemStore: createWorkItemStore(db),
    widgetStore: createWidgetStore(db),
    planningGroupStore: createPlanningGroupStore(db),
    gitClient: createGitClientFromCredentials(credentialStore),
    localGitClient,
    gitCacheStore: createGitCacheStore(db),
    analysisResultStore: createAnalysisResultStore(db),
    llmClient: createLlmClient(llmConfigStore),
    agentClient: createAgentClient(aiAgentStore, agentToolStore, llmConfigStore),
    codeIndex: codeIndexService,
  };

  await seedPlatformData(db);
  const authenticityAgentId = await seedAuthenticityAgent(aiAgentStore, agentToolStore);

  const registeredWorkflows = buildRegisteredWorkflows(credentialStore, authenticityAgentId);

  for (const { workflow, cron, connectorProvider } of Object.values(registeredWorkflows)) {
    await ensureWorkflowRow(db, await resolveWorkflow(workflow), /* isSystem */ true);
    scheduleWorkflow(db, workflow, cron, services, connectorProvider);
  }

  const ctx: BackendContext = {
    db,
    services,
    workflowStore,
    credentialStore,
    llmConfigStore,
    aiAgentStore,
    agentToolStore,
    appSettingsStore,
    jiraImportJobs,
    chunkedUploads,
    ticketSyncConflictStore,
    codeSearchSettingsStore,
    codeIndexStore,
    registeredWorkflows,
  };

  // Default (1MB) is too small for some real workflow payloads — e.g. the ad-hoc workflow body on
  // `/run`, or a git node's "Read Project Files" output flowing through `/node-types/:type/execute`'s
  // `input` — which were failing with "Payload Too Large" (413) before this.
  const app = Fastify({ logger: true, bodyLimit: 50 * 1024 * 1024 });

  // Dev-only permissive CORS — admin-ui (Vite, a different origin/port) calls this API directly from
  // the browser. Tighten to an explicit allowlist before this backend is ever exposed beyond localhost.
  await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  registerHealthRoutes(app);
  registerNodeTypeRoutes(app, ctx);
  registerWorkflowRoutes(app, ctx);
  registerUploadRoutes(app, ctx);
  registerAlertRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerMemberRoutes(app, ctx);
  registerWorkItemRoutes(app, ctx);
  registerPlanningGroupRoutes(app, ctx);
  registerWidgetRoutes(app, ctx);
  registerGithubRoutes(app, ctx);
  registerIntegrationRoutes(app, ctx);
  registerLlmConfigRoutes(app, ctx);
  registerAiAgentRoutes(app, ctx);
  registerAgentToolRoutes(app, ctx);
  registerLocalGitRoutes(app, ctx);
  registerTicketRoutes(app, ctx);

  return app;
}
