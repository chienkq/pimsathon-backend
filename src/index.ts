import {
  executeSingleNode,
  getIntegrationProvider,
  getLlmProvider,
  GIT_CONTROL_PROVIDER_IDS,
  INTEGRATION_PROVIDERS,
  listNodeTypeMetas,
  LLM_PROVIDERS,
  WORK_ITEM_STATUSES,
  type GitControlDefaultSource,
  type IntegrationProviderId,
  type LlmProviderId,
  type NodeExecutionData,
  type WorkflowDefinition,
  type WorkflowNodeDefinition,
} from "@chienkq/workflow-core";
import {
  alerts,
  branches,
  connectorStatus,
  createDb,
  githubIssues,
  issueLinks,
  members,
  projects,
  pullRequests,
  repositories,
  widgets,
  workflowRuns,
  workItems,
} from "@chienkq/workflow-db";
import { and, desc, eq, inArray } from "drizzle-orm";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { createAlertStore } from "./alertStore.js";
import { createAnalysisResultStore } from "./analysisResultStore.js";
import {
  deletePlanningGroupFromAdminUi,
  deleteWorkItemFromAdminUi,
  upsertPlanningGroupFromAdminUi,
  upsertWorkItemFromAdminUi,
  type AdminUiPlanningGroupFields,
  type AdminUiWorkItemFields,
} from "./adminUiSync.js";
import { createAppSettingsStore } from "./appSettingsStore.js";
import { createCredentialStore } from "./credentialStore.js";
import { env } from "./env.js";
import { createTicketStore } from "./ticketStore.js";
import { createTicketSyncConflictStore } from "./ticketSyncConflictStore.js";
import { createGitCacheStore } from "./gitCacheStore.js";
import { createGitClientFromCredentials, listAccountRepositories } from "./githubClient.js";
import { createGmailClient } from "./gmailClient.js";
import { createJiraClientFromCredentials } from "./jiraClient.js";
import { createLlmConfigStore, type LlmConfigInput } from "./llmConfigStore.js";
import { listLlmModels, testLlmConfig } from "./llmProviderTest.js";
import { createLocalGitClientFromCredentials, testLocalGitConnection } from "./localGitClient.js";
import { parseJiraExcelImport } from "./jiraExcelImport.js";
import { convertNamesToPlanningGroups, convertTicketsToWorkItems, previewTicketConversions } from "./jiraTicketToWorkItem.js";
import { createJiraImportJobStore } from "./jiraImportJobs.js";
import { createLlmClient } from "./llmClient.js";
import { createOutlookClient } from "./outlookClient.js";
import { ensureWorkflowRow, resolveWorkflow, runWorkflow, type RunnerServices } from "./runner.js";
import { scheduleWorkflow } from "./scheduler.js";
import { createSlackClient } from "./slackClient.js";
import { createTeamsClient } from "./teamsClient.js";
import { createWorkflowStore } from "./workflowStore.js";
import { seedPlatformData } from "./seedPlatformData.js";
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
} from "./seedWorkflow.js";
import {
  ANALYZE_CYCLE_WORKFLOW_ID,
  ANALYZE_MODULE_WORKFLOW_ID,
  ANALYZE_WORKITEM_HEALTH_WORKFLOW_ID,
  ANALYZE_WORKITEM_LOCAL_SOURCE_WORKFLOW_ID,
  buildAnalyzeCycleWorkflow,
  buildAnalyzeModuleWorkflow,
  buildAnalyzeWorkItemHealthWorkflow,
  buildAnalyzeWorkItemLocalSourceWorkflow,
} from "./seedAnalyzeWorkflows.js";
import { createPlanningGroupStore } from "./planningGroupStore.js";
import { getProjectHealth } from "./projectHealth.js";
import { createWidgetStore } from "./widgetStore.js";
import { createWorkItemStore } from "./workItemStore.js";

const db = createDb(env.databaseUrl);
const workflowStore = createWorkflowStore(db);
const credentialStore = createCredentialStore(db);
const llmConfigStore = createLlmConfigStore(db);
const appSettingsStore = createAppSettingsStore(db);
const jiraImportJobs = createJiraImportJobStore();
const ticketSyncConflictStore = createTicketSyncConflictStore(db);
// Full-typed (getFileSnippet + listBranches/getStatus/getLog/getConfigList) — also used directly by
// the `/api/local-git/*` routes below, not just as the narrower `LocalGitClientService` the `git`
// node asks for.
const localGitClient = createLocalGitClientFromCredentials(credentialStore);
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
};

await seedPlatformData(db);

/** Registered workflows, keyed by id — `connectorProvider` is set only for connector-sync workflows (W1, W3), not rule/metric workflows (W8-W10, W11). */
const registeredWorkflows = {
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
} as const;

for (const { workflow, cron, connectorProvider } of Object.values(registeredWorkflows)) {
  await ensureWorkflowRow(db, await resolveWorkflow(workflow), /* isSystem */ true);
  scheduleWorkflow(db, workflow, cron, services, connectorProvider);
}

const app = Fastify({ logger: true });

// Dev-only permissive CORS — admin-ui (Vite, a different origin/port) calls this API directly from
// the browser. Tighten to an explicit allowlist before this backend is ever exposed beyond localhost.
await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] });
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

app.get("/health", async () => ({ status: "ok" }));

// The Add-Node panel's node type list — metadata only (no `execute`, functions can't cross HTTP),
// stripped from the same `nodeTypeRegistry` the runner executes nodes against.
app.get("/api/node-types", async () => ({ nodeTypes: listNodeTypeMetas() }));

// User-authored workflows (the editor's own CRUD), backed by the same `workflows` table the
// pre-registered code workflows below live in — distinct from `/api/workflows/:id/run`, which only
// runs the fixed set of built-in workflows registered at startup, not arbitrary saved ones.
app.get("/api/workflows", async (request) => {
  const { inputNodeType } = request.query as { inputNodeType?: string };
  const workflows = inputNodeType ? await workflowStore.listByInputNodeType(inputNodeType) : await workflowStore.list();
  return { workflows };
});

app.get("/api/workflows/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const workflow = await workflowStore.get(id);
  if (!workflow) return reply.code(404).send({ error: `Unknown workflow: ${id}` });
  return { workflow };
});

app.post("/api/workflows", async (request, reply) => {
  const { name, nodes } = (request.body as { name?: string; nodes?: WorkflowNodeDefinition[] } | undefined) ?? {};
  if (!name) return reply.code(400).send({ error: "Body must include `name`." });
  const workflow = await workflowStore.create(name, nodes);
  return reply.code(201).send({ workflow });
});

app.put("/api/workflows/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as Partial<WorkflowDefinition> | undefined;
  if (!body || !body.name || !body.nodes || !body.connections) {
    return reply.code(400).send({ error: "Body must include at least name, nodes, and connections." });
  }
  try {
    const workflow = await workflowStore.save({ ...body, id } as WorkflowDefinition);
    return { workflow };
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/workflows/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    await workflowStore.remove(id);
    return { status: "success" };
  } catch (error) {
    return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/workflows/:id/duplicate", async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const workflow = await workflowStore.duplicate(id);
    return reply.code(201).send({ workflow });
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.patch("/api/workflows/:id/active", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { active } = (request.body as { active?: boolean } | undefined) ?? {};
  if (typeof active !== "boolean") return reply.code(400).send({ error: "Body must include boolean `active`." });
  try {
    const workflow = await workflowStore.setActive(id, active);
    return { workflow };
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/workflows/:id/run", async (request, reply) => {
  const { id } = request.params as { id: string };
  const entry = (registeredWorkflows as Record<string, (typeof registeredWorkflows)[keyof typeof registeredWorkflows]>)[
    id
  ];
  const { workflow: adHocWorkflow } = (request.body as { workflow?: WorkflowDefinition } | undefined) ?? {};

  // Ad-hoc run (the editor's "Run" button, possibly with unsaved edits) takes precedence over both
  // the fixed registered set and whatever's currently saved for this id; falls back to a saved
  // user-authored workflow (from the `/api/workflows` CRUD routes) when no body is given.
  const workflow = adHocWorkflow ?? (entry ? await resolveWorkflow(entry.workflow) : undefined) ?? (await workflowStore.get(id));
  if (!workflow) return reply.code(404).send({ error: `Unknown workflow: ${id}` });

  try {
    if (adHocWorkflow) await ensureWorkflowRow(db, adHocWorkflow);
    const result = await runWorkflow(db, workflow, services, "manual", entry?.connectorProvider);
    if (result.status === "error") {
      return reply.code(502).send({
        status: result.status,
        nodeResults: result.nodeResults,
        runId: result.runId,
        error: "Workflow run finished with a node error — see nodeResults for details.",
      });
    }
    return { status: result.status, nodeResults: result.nodeResults, runId: result.runId };
  } catch (error) {
    return reply.code(500).send({ status: "error", error: error instanceof Error ? error.message : String(error) });
  }
});

// The NDV "Execute" button — runs one node type in isolation against the real backend services
// (e.g. the workItem node's Jira/DB-backed CRUD), bypassing the graph. `input` is whatever the
// editor already resolved client-side from the upstream node's last result.
app.post("/api/node-types/:type/execute", async (request, reply) => {
  const { type } = request.params as { type: string };
  const { parameters, input } = (request.body as { parameters?: Record<string, unknown>; input?: NodeExecutionData[] } | undefined) ?? {};
  try {
    const result = await executeSingleNode(type, parameters ?? {}, input ?? [], services as unknown as Record<string, unknown>);
    if (result.status === "error") return reply.code(502).send(result);
    return result;
  } catch (error) {
    return reply.code(500).send({ status: "error", error: error instanceof Error ? error.message : String(error) });
  }
});

// Run history for the editor's Run Logs panel — every `runWorkflow` call (scheduled, webhook, or
// manual) already writes a row to `workflow_runs`, this just exposes it. List omits `output` (can
// be large and isn't needed for the row view); detail includes it for the timeline.
app.get("/api/workflows/:id/runs", async (request) => {
  const { id } = request.params as { id: string };
  const rows = await db
    .select({
      id: workflowRuns.id,
      status: workflowRuns.status,
      trigger: workflowRuns.trigger,
      startedAt: workflowRuns.startedAt,
      finishedAt: workflowRuns.finishedAt,
      error: workflowRuns.error,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, id))
    .orderBy(desc(workflowRuns.startedAt))
    .limit(50);
  return { runs: rows };
});

app.get("/api/workflows/:id/runs/:runId", async (request, reply) => {
  const { id, runId } = request.params as { id: string; runId: string };
  const [row] = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.workflowId, id), eq(workflowRuns.id, runId)))
    .limit(1);
  if (!row) return reply.code(404).send({ error: `Unknown run: ${runId}` });
  return { run: { ...row, nodeResults: row.output ?? {} } };
});

// Real inbound webhook receiver — the `webhook` node reads `services.webhookRequest` (see
// nodeTypes/webhook.ts) when present instead of its old always-simulated shape. Looked up the same
// way `/api/workflows/:id/run` resolves a workflow (registered built-ins ensured into `workflows` at
// startup, or a user-authored one saved via the CRUD routes) so any workflow — not just a fixed
// set — can receive a real Jira/GitHub webhook just by having a `webhook` node and being saved/active.
app.all("/api/webhooks/:workflowId", async (request, reply) => {
  const { workflowId } = request.params as { workflowId: string };
  const entry = (registeredWorkflows as Record<string, (typeof registeredWorkflows)[keyof typeof registeredWorkflows]>)[
    workflowId
  ];
  const workflow = (entry ? await resolveWorkflow(entry.workflow) : undefined) ?? (await workflowStore.get(workflowId));
  if (!workflow) return reply.code(404).send({ error: `Unknown workflow: ${workflowId}` });

  const webhookRequest = {
    path: request.url,
    method: request.method,
    headers: request.headers as Record<string, string>,
    query: request.query as Record<string, unknown>,
    body: request.body,
    receivedAt: new Date().toISOString(),
  };

  try {
    const result = await runWorkflow(db, workflow, { ...services, webhookRequest }, "webhook", entry?.connectorProvider);
    if (result.status === "error") {
      return reply.code(502).send({
        status: result.status,
        nodeResults: result.nodeResults,
        runId: result.runId,
        error: "Workflow run finished with a node error — see nodeResults for details.",
      });
    }
    return { status: result.status, nodeResults: result.nodeResults, runId: result.runId };
  } catch (error) {
    return reply.code(500).send({ status: "error", error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/alerts", async (request) => {
  const { workItemId } = request.query as { workItemId?: string };
  const rows = await db
    .select()
    .from(alerts)
    .where(workItemId ? eq(alerts.workItemId, workItemId) : undefined)
    .orderBy(desc(alerts.updatedAt))
    .limit(200);
  return { alerts: rows };
});

// Platform data — the same tables the `workItem` node reads/writes. admin-ui's `DemoProvider`
// fetches these three on load and replaces its local projects/members/workItems with them (see
// admin-ui's `state/store.tsx`), which is what makes the two sides agree on identity.
app.get("/api/projects", async () => ({ projects: await db.select().from(projects) }));

function parseProjectInput(body: unknown): { name: string; code: string; description: string; memberIds: string[] } {
  const input = (body ?? {}) as Partial<{ name: string; code: string; description: string; memberIds: string[] }>;
  if (!input.name?.trim()) throw new Error("Name is required.");
  if (!input.code?.trim()) throw new Error("Code is required.");
  return {
    name: input.name.trim(),
    code: input.code.trim(),
    description: input.description?.trim() ?? "",
    memberIds: Array.isArray(input.memberIds) ? input.memberIds : [],
  };
}

app.post("/api/projects", async (request, reply) => {
  try {
    const [project] = await db
      .insert(projects)
      .values({ id: crypto.randomUUID(), color: "#496ce0", nextNumber: 1, ...parseProjectInput(request.body) })
      .returning();
    return reply.code(201).send({ project });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put("/api/projects/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const [existing] = await db.select().from(projects).where(eq(projects.id, id));
  if (!existing) return reply.code(404).send({ error: `Unknown project: ${id}` });
  try {
    const [project] = await db
      .update(projects)
      .set(parseProjectInput(request.body))
      .where(eq(projects.id, id))
      .returning();
    return { project };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/projects/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const [existing] = await db.select().from(projects).where(eq(projects.id, id));
  if (!existing) return reply.code(404).send({ error: `Unknown project: ${id}` });
  await db.delete(projects).where(eq(projects.id, id));
  return { status: "success" };
});

app.get("/api/members", async () => ({ members: await db.select().from(members) }));

function parseMemberInput(body: unknown): { name: string; initials: string; color: string; login: string } {
  const input = (body ?? {}) as Partial<{ name: string; initials: string; color: string; login: string }>;
  if (!input.name?.trim()) throw new Error("Name is required.");
  if (!input.login?.trim()) throw new Error("Login is required.");
  const name = input.name.trim();
  return {
    name,
    initials:
      input.initials?.trim() ||
      name
        .split(/\s+/)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase(),
    color: input.color?.trim() || "#6366f1",
    login: input.login.trim(),
  };
}

app.post("/api/members", async (request, reply) => {
  try {
    const [member] = await db
      .insert(members)
      .values({ id: crypto.randomUUID(), ...parseMemberInput(request.body) })
      .returning();
    return reply.code(201).send({ member });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put("/api/members/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const [existing] = await db.select().from(members).where(eq(members.id, id));
  if (!existing) return reply.code(404).send({ error: `Unknown member: ${id}` });
  try {
    const [member] = await db
      .update(members)
      .set(parseMemberInput(request.body))
      .where(eq(members.id, id))
      .returning();
    return { member };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/members/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const [existing] = await db.select().from(members).where(eq(members.id, id));
  if (!existing) return reply.code(404).send({ error: `Unknown member: ${id}` });
  await db.delete(members).where(eq(members.id, id));
  return { status: "success" };
});

app.get("/api/work-items", async () => ({ workItems: await services.workItemStore.list({}) }));

// Latest result from the "Analyze Work Item Health" workflow for one work item — null until that
// workflow has run at least once for this item (see analysisResultStore.ts / seedAnalyzeWorkflows.ts).
app.get("/api/work-items/:id/health", async (request) => {
  const { id } = request.params as { id: string };
  const [latest] = await services.analysisResultStore.queryLatest("workItem", id, 1);
  return { health: latest ?? null };
});

// admin-ui's own write path — upsert-by-id, scoped to the fields admin-ui owns (see adminUiSync.ts).
// admin-ui assigns `id`/`number` itself and this never overrides them, so identity always stays
// admin-ui's local reducer's call, not this backend's.
app.put("/api/work-items/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as Partial<AdminUiWorkItemFields> | undefined;
  if (!body || body.projectId === undefined || body.number === undefined || !body.title) {
    return reply.code(400).send({ error: "Body must include at least projectId, number, and title." });
  }
  try {
    await upsertWorkItemFromAdminUi(db, {
      id,
      projectId: body.projectId,
      number: body.number,
      title: body.title,
      description: body.description ?? "",
      status: body.status ?? "Todo",
      priority: body.priority ?? "Medium",
      assigneeId: body.assigneeId ?? "",
      labels: body.labels ?? [],
      startDate: body.startDate ?? "",
      dueDate: body.dueDate ?? "",
      cycleId: body.cycleId ?? "",
      moduleIds: body.moduleIds ?? [],
      aiNote: body.aiNote ?? "",
    });
    return { status: "success" };
  } catch (error) {
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/work-items/:id", async (request) => {
  const { id } = request.params as { id: string };
  await deleteWorkItemFromAdminUi(db, id);
  return { status: "success" };
});

// Cycles/modules — same shape as admin-ui's own `PlanningGroup` (`kind` discriminates the two, see
// schema.ts). admin-ui replaces its local cycles/modules with this list wholesale on load, same as
// projects/members/workItems, so `PATCH .../status`-style partial writes aren't needed here — a
// full upsert-by-id is enough (see adminUiSync.ts's `upsertPlanningGroupFromAdminUi`).
app.get("/api/planning-groups", async () => ({ planningGroups: await services.planningGroupStore.list({}) }));

app.put("/api/planning-groups/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as Partial<AdminUiPlanningGroupFields> | undefined;
  if (!body || !body.projectId || !body.kind || !body.name) {
    return reply.code(400).send({ error: "Body must include at least projectId, kind, and name." });
  }
  try {
    await upsertPlanningGroupFromAdminUi(db, {
      id,
      projectId: body.projectId,
      kind: body.kind,
      name: body.name,
      description: body.description ?? "",
      startDate: body.startDate ?? "",
      endDate: body.endDate ?? "",
      leadId: body.leadId ?? "",
    });
    return { status: "success" };
  } catch (error) {
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/planning-groups/:id", async (request) => {
  const { id } = request.params as { id: string };
  await deletePlanningGroupFromAdminUi(db, id);
  return { status: "success" };
});

// Per-project Project Health Dashboard data (workload, bugs, milestones, alerts) — see
// projectHealth.ts for why this is computed live rather than read from the global `widgets` table.
app.get("/api/projects/:id/health", async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    return await getProjectHealth(db, id);
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/widgets", async () => ({ widgets: await db.select().from(widgets).orderBy(desc(widgets.updatedAt)) }));

app.get("/api/widgets/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const [widget] = await db.select().from(widgets).where(eq(widgets.widgetId, id));
  if (!widget) return reply.code(404).send({ error: `Unknown widget: ${id}` });
  return { widget };
});

// Real GitHub data, synced by W3 (GitHub Sync) into Postgres. Branch/PR creation now writes
// through to the real GitHub API too (see the POST routes below); Issue create/edit still isn't.
app.get("/api/repositories", async () => ({ repositories: await db.select().from(repositories) }));

// Live list of every repo the connected GitHub account can see (not just the single owner/repo
// pinned in the credential config for W3) — upserts each into `repositories` so it gets a stable
// `id` and can then go through the normal `/connect` route below like any other known repo.
app.get("/api/repositories/github", async (request, reply) => {
  const config = await credentialStore.getConfig("github");
  if (!config?.token)
    return reply.code(400).send({ error: "GitHub is not connected. Configure it in Settings → Integrations." });
  let accountRepos: Awaited<ReturnType<typeof listAccountRepositories>>;
  try {
    accountRepos = await listAccountRepositories(config.token);
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "Failed to list GitHub repositories." });
  }
  await Promise.all(
    accountRepos.map((r) => services.gitCacheStore.upsertRepository(r.owner, r.name, { defaultBranch: r.defaultBranch }))
  );
  return { repositories: await db.select().from(repositories) };
});

// Manual, on-demand pull of branches/PRs/Issues straight from GitHub into the cache tables — the
// "reload" icon in WorkItemGit.tsx, so a branch/PR/Issue created directly on GitHub shows up for
// linking without waiting for the 15-min GitHub Sync cron (see seedWorkflow.ts's buildGitHubSyncWorkflow).
app.post("/api/repositories/:id/sync", async (request, reply) => {
  const { id } = request.params as { id: string };
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, id));
  if (!repo) return reply.code(404).send({ error: `Unknown repository: ${id}` });
  try {
    const [branchList, pullRequestList, issueList] = await Promise.all([
      services.gitClient.listBranches(repo.owner, repo.name),
      services.gitClient.listPullRequests(repo.owner, repo.name, "all"),
      services.gitClient.listIssues(repo.owner, repo.name, "all"),
    ]);
    await Promise.all([
      services.gitCacheStore.upsertBranches(repo.owner, repo.name, branchList),
      services.gitCacheStore.upsertPullRequests(repo.owner, repo.name, pullRequestList),
      services.gitCacheStore.upsertIssues(repo.owner, repo.name, issueList),
    ]);
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "Failed to sync from GitHub." });
  }
  return { status: "success" };
});

app.get("/api/repositories/:id/branches", async (request) => {
  const { id } = request.params as { id: string };
  return { branches: await db.select().from(branches).where(eq(branches.repositoryId, id)) };
});

app.get("/api/repositories/:id/pull-requests", async (request) => {
  const { id } = request.params as { id: string };
  return { pullRequests: await db.select().from(pullRequests).where(eq(pullRequests.repositoryId, id)) };
});

// Creates a real branch on GitHub (from the repo's default branch) and mirrors it into the cache
// table so it shows up immediately via the GET route above — see WorkItemGit.tsx's "Branches" section.
app.post("/api/repositories/:id/branches", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { name, workItemId } = request.body as { name?: string; workItemId?: string | null };
  if (!name?.trim()) return reply.code(400).send({ error: "Body must include `name`." });
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, id));
  if (!repo) return reply.code(404).send({ error: `Unknown repository: ${id}` });
  let created: Awaited<ReturnType<typeof services.gitClient.createBranch>>;
  try {
    created = await services.gitClient.createBranch(repo.owner, repo.name, { name: name.trim(), fromBranch: repo.defaultBranch });
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "Failed to create branch on GitHub." });
  }
  const [branch] = await db
    .insert(branches)
    .values({ id: crypto.randomUUID(), repositoryId: id, name: created.name, sha: created.sha, workItemId: workItemId ?? null })
    .onConflictDoUpdate({
      target: [branches.repositoryId, branches.name],
      set: { sha: created.sha, workItemId: workItemId ?? null, syncedAt: new Date() },
    })
    .returning();
  return { branch };
});

// Links an already-cached branch (created directly on GitHub, or synced before it had a work item)
// to a work item — the "select an existing branch" flow in WorkItemGit.tsx, mirroring /api/issue-links.
app.patch("/api/branches/:id/link", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { workItemId } = request.body as { workItemId?: string | null };
  if (workItemId === undefined) return reply.code(400).send({ error: "Body must include `workItemId` (string or null)." });
  const [branch] = await db.update(branches).set({ workItemId }).where(eq(branches.id, id)).returning();
  if (!branch) return reply.code(404).send({ error: `Unknown branch: ${id}` });
  return { branch };
});

// Creates a real pull request on GitHub and mirrors it into the cache table — see WorkItemGit.tsx's
// "Pull requests" section.
app.post("/api/repositories/:id/pull-requests", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { headBranch, title, workItemId } = request.body as { headBranch?: string; title?: string; workItemId?: string | null };
  if (!headBranch?.trim() || !title?.trim())
    return reply.code(400).send({ error: "Body must include `headBranch` and `title`." });
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, id));
  if (!repo) return reply.code(404).send({ error: `Unknown repository: ${id}` });
  let created: Awaited<ReturnType<typeof services.gitClient.createPullRequest>>;
  try {
    created = await services.gitClient.createPullRequest(repo.owner, repo.name, {
      title: title.trim(),
      head: headBranch.trim(),
      base: repo.defaultBranch,
    });
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "Failed to open pull request on GitHub." });
  }
  const [pullRequest] = await db
    .insert(pullRequests)
    .values({
      id: crypto.randomUUID(),
      repositoryId: id,
      number: created.number,
      headBranch: created.headBranch,
      baseBranch: created.baseBranch,
      title: created.title,
      status: created.status,
      url: created.url,
      workItemId: workItemId ?? null,
    })
    .onConflictDoUpdate({
      target: [pullRequests.repositoryId, pullRequests.number],
      set: {
        headBranch: created.headBranch,
        baseBranch: created.baseBranch,
        title: created.title,
        status: created.status,
        url: created.url,
        workItemId: workItemId ?? null,
        syncedAt: new Date(),
      },
    })
    .returning();
  return { pullRequest };
});

// Links an already-cached pull request (opened directly on GitHub, or synced before it had a work
// item) to a work item — the "select an existing PR" flow in WorkItemGit.tsx, mirroring /api/issue-links.
app.patch("/api/pull-requests/:id/link", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { workItemId } = request.body as { workItemId?: string | null };
  if (workItemId === undefined) return reply.code(400).send({ error: "Body must include `workItemId` (string or null)." });
  const [pullRequest] = await db.update(pullRequests).set({ workItemId }).where(eq(pullRequests.id, id)).returning();
  if (!pullRequest) return reply.code(404).send({ error: `Unknown pull request: ${id}` });
  return { pullRequest };
});

app.get("/api/repositories/:id/issues", async (request) => {
  const { id } = request.params as { id: string };
  return { issues: await db.select().from(githubIssues).where(eq(githubIssues.repositoryId, id)) };
});

// Work item <-> GitHub Issue links (admin-ui's own bookkeeping, not a GitHub concept) — persisted
// here so a link survives a reload instead of living only in admin-ui's in-memory local state.
app.get("/api/issue-links", async () => ({ issueLinks: await db.select().from(issueLinks) }));

app.post("/api/issue-links", async (request, reply) => {
  const { workItemId, issueId, base } = request.body as {
    workItemId?: string;
    issueId?: string;
    base?: { title: string; description: string; labels: string[]; assignee: string; state: "open" | "closed" };
  };
  if (!workItemId || !issueId || !base)
    return reply.code(400).send({ error: "Body must include `workItemId`, `issueId` and `base`." });
  try {
    const [link] = await db.insert(issueLinks).values({ id: crypto.randomUUID(), workItemId, issueId, base }).returning();
    return { issueLink: link };
  } catch {
    return reply.code(409).send({ error: "This work item or Issue is already linked." });
  }
});

// admin-ui's "connect a repository to a project" — the only write this backend accepts for
// GitHub data today. The link lives on the project (one repo per project, but a repo can be
// linked to several projects), so this is a project-scoped route. `repositoryId: null` disconnects;
// setting it to a different repo re-points the project (this is how "change repository" works).
app.patch("/api/projects/:id/repository", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { repositoryId } = request.body as { repositoryId: string | null | undefined };
  if (repositoryId === undefined)
    return reply.code(400).send({ error: "Body must include `repositoryId` (string or null)." });
  await db.update(projects).set({ repositoryId }).where(eq(projects.id, id));
  return { status: "success" };
});

app.patch("/api/work-items/:id/status", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { status } = request.body as { status?: string };
  if (!status || !WORK_ITEM_STATUSES.includes(status as (typeof WORK_ITEM_STATUSES)[number])) {
    return reply.code(400).send({ error: `Body must include a valid \`status\`: ${WORK_ITEM_STATUSES.join(", ")}.` });
  }
  try {
    const updated = await services.workItemStore.moveStatus(id, status as (typeof WORK_ITEM_STATUSES)[number]);
    return { workItem: updated };
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Integrations screen (W6) — connect/configure Jira, GitHub, Slack, Teams, Outlook, Gmail. Secrets
// are AES-256-GCM encrypted at rest (credentialStore.ts) and NEVER echoed back to the client; the
// list route only reports which config keys are currently set.
app.get("/api/integrations", async () => {
  const configured = await credentialStore.listConfiguredProviders();
  const statusRows = await db.select().from(connectorStatus);
  const statusByProvider = new Map(statusRows.map((row) => [row.provider, row]));
  return {
    integrations: INTEGRATION_PROVIDERS.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      description: provider.description,
      color: provider.color,
      fields: provider.fields.map(({ key, label, type, placeholder, helpText }) => ({
        key,
        label,
        type,
        placeholder,
        helpText,
      })),
      category: provider.category,
      connected: configured.has(provider.id),
      status: statusByProvider.get(provider.id) ?? null,
    })),
  };
});

app.put("/api/integrations/:provider", async (request, reply) => {
  const { provider } = request.params as { provider: string };
  const spec = getIntegrationProvider(provider);
  if (!spec) return reply.code(404).send({ error: `Unknown integration provider: ${provider}` });

  const { config } = (request.body as { config?: Record<string, string> } | undefined) ?? {};
  if (!config) return reply.code(400).send({ error: "Body must include `config`." });
  const missing = spec.fields.filter((field) => !config[field.key]).map((field) => field.key);
  if (missing.length > 0) return reply.code(400).send({ error: `Missing required field(s): ${missing.join(", ")}` });

  const trimmed = Object.fromEntries(spec.fields.map((field) => [field.key, config[field.key]]));
  await credentialStore.setConfig(spec.id, trimmed);
  return { status: "success" };
});

app.delete("/api/integrations/:provider", async (request, reply) => {
  const { provider } = request.params as { provider: string };
  const spec = getIntegrationProvider(provider);
  if (!spec) return reply.code(404).send({ error: `Unknown integration provider: ${provider}` });
  await credentialStore.remove(spec.id);
  await db.delete(connectorStatus).where(eq(connectorStatus.provider, spec.id));
  return { status: "success" };
});

async function testIntegration(provider: IntegrationProviderId): Promise<{ ok: boolean; detail?: string }> {
  const config = await credentialStore.getConfig(provider);
  if (!config) throw new Error(`${provider} is not configured yet.`);

  switch (provider) {
    case "jira": {
      const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
      const response = await fetch(`${config.baseUrl}/rest/api/3/myself`, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Jira auth check failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { displayName?: string };
      return { ok: true, detail: data.displayName };
    }
    case "github": {
      const response = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${config.token}`, Accept: "application/vnd.github+json" },
      });
      if (!response.ok) throw new Error(`GitHub auth check failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { login?: string };
      return { ok: true, detail: data.login };
    }
    case "slack":
      return createSlackClient({ botToken: config.botToken }).testConnection();
    case "teams":
      return createTeamsClient({ webhookUrl: config.webhookUrl }).testConnection();
    case "outlook":
      return createOutlookClient({
        tenantId: config.tenantId,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        senderUpn: config.senderUpn,
      }).testConnection();
    case "gmail":
      return createGmailClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: config.refreshToken,
        fromEmail: config.fromEmail,
      }).testConnection();
    case "local-git":
      return testLocalGitConnection(config.repoPath);
  }
}

app.post("/api/integrations/:provider/test", async (request, reply) => {
  const { provider } = request.params as { provider: string };
  const spec = getIntegrationProvider(provider);
  if (!spec) return reply.code(404).send({ error: `Unknown integration provider: ${provider}` });

  try {
    const result = await testIntegration(spec.id);
    await db
      .insert(connectorStatus)
      .values({ provider: spec.id, lastSyncAt: new Date(), lastSuccess: true, lastError: null })
      .onConflictDoUpdate({
        target: connectorStatus.provider,
        set: { lastSyncAt: new Date(), lastSuccess: true, lastError: null },
      });
    return { status: "success", ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .insert(connectorStatus)
      .values({ provider: spec.id, lastSyncAt: new Date(), lastSuccess: false, lastError: message })
      .onConflictDoUpdate({
        target: connectorStatus.provider,
        set: { lastSyncAt: new Date(), lastSuccess: false, lastError: message },
      });
    return reply.code(502).send({ status: "error", error: message });
  }
});

// LLM Settings screen (Automation sidebar) — CRUD named LLM setups (provider + model + generation
// params) that AI-flavored nodes can be pointed at. API keys are AES-256-GCM encrypted at rest
// (llmConfigStore.ts) and never echoed back to the client — `list`/`get` only report `hasApiKey`.
app.get("/api/llm-providers", async () => ({
  providers: LLM_PROVIDERS.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    description: p.description,
    color: p.color,
    connectionFields: p.connectionFields,
    defaultModel: p.defaultModel,
    modelPlaceholder: p.modelPlaceholder,
  })),
}));

app.get("/api/llm-configs", async () => ({ configs: await llmConfigStore.list() }));

/**
 * `keepExistingApiKey` is true when updating a config that already has a stored key and the request
 * left `apiKey` blank — that means "leave it as-is", not "this provider needs no key", so the
 * required-field check is skipped for just that case.
 */
function parseLlmConfigInput(body: unknown, keepExistingApiKey = false): LlmConfigInput {
  const input = (body ?? {}) as Partial<LlmConfigInput> & { provider?: string };
  const spec = getLlmProvider(input.provider ?? "");
  if (!spec) throw new Error(`Unknown LLM provider: ${input.provider}`);
  if (!input.name?.trim()) throw new Error("Name is required.");
  if (!input.model?.trim()) throw new Error("Model is required.");

  const extra: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of spec.connectionFields) {
    if (field.key === "apiKey" || field.key === "baseUrl") continue;
    const value = (input.extra as Record<string, string> | undefined)?.[field.key];
    if (field.required && !value?.trim()) missing.push(field.label);
    if (value) extra[field.key] = value.trim();
  }
  const needsApiKey = spec.connectionFields.some((f) => f.key === "apiKey" && f.required);
  if (needsApiKey && !input.apiKey && !keepExistingApiKey) missing.push("API Key");
  const needsBaseUrl = spec.connectionFields.some((f) => f.key === "baseUrl" && f.required);
  if (needsBaseUrl && !input.baseUrl?.trim()) missing.push("Base URL");
  if (missing.length > 0) throw new Error(`Missing required field(s): ${missing.join(", ")}`);

  return {
    name: input.name.trim(),
    provider: spec.id as LlmProviderId,
    model: input.model.trim(),
    apiKey: input.apiKey,
    baseUrl: input.baseUrl?.trim(),
    extra,
    temperature: input.temperature ?? 0.7,
    maxTokens: input.maxTokens ?? 1024,
    topP: input.topP,
    timeoutMs: input.timeoutMs ?? 60000,
    systemPrompt: input.systemPrompt?.trim(),
  };
}

app.post("/api/llm-configs", async (request, reply) => {
  try {
    const config = await llmConfigStore.create(parseLlmConfigInput(request.body));
    return reply.code(201).send({ config });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put("/api/llm-configs/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const existing = await llmConfigStore.get(id);
  if (!existing) return reply.code(404).send({ error: `Unknown LLM config: ${id}` });
  try {
    const config = await llmConfigStore.update(id, parseLlmConfigInput(request.body, existing.hasApiKey));
    return { config };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/llm-configs/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await llmConfigStore.get(id))) return reply.code(404).send({ error: `Unknown LLM config: ${id}` });
  await llmConfigStore.remove(id);
  return { status: "success" };
});

app.patch("/api/llm-configs/:id/default", async (request, reply) => {
  const { id } = request.params as { id: string };
  const config = await llmConfigStore.setDefault(id);
  if (!config) return reply.code(404).send({ error: `Unknown LLM config: ${id}` });
  return { config };
});

/**
 * Backs the Model field's dropdown: called on focus with whatever connection fields are filled in so
 * far (the config may not be saved yet). When editing a config whose API key was left blank
 * ("keep the current key"), `configId` lets us borrow the already-stored key instead of asking the
 * form to resend it.
 */
app.post("/api/llm-configs/models", async (request, reply) => {
  const body = (request.body ?? {}) as {
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
    extra?: Record<string, string>;
    configId?: string;
  };
  const spec = getLlmProvider(body.provider ?? "");
  if (!spec) return reply.code(400).send({ error: `Unknown LLM provider: ${body.provider}` });
  let apiKey = body.apiKey;
  if (!apiKey && body.configId) {
    const existing = await llmConfigStore.getWithSecret(body.configId);
    apiKey = existing?.apiKey;
  }
  try {
    const models = await listLlmModels(spec.id as LlmProviderId, { apiKey, baseUrl: body.baseUrl, extra: body.extra ?? {} });
    return { models };
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/llm-configs/:id/test", async (request, reply) => {
  const { id } = request.params as { id: string };
  const config = await llmConfigStore.getWithSecret(id);
  if (!config) return reply.code(404).send({ error: `Unknown LLM config: ${id}` });
  try {
    const result = await testLlmConfig(config.provider, { apiKey: config.apiKey, baseUrl: config.baseUrl ?? undefined, extra: config.extra });
    return { status: "success", ...result };
  } catch (error) {
    return reply.code(502).send({ status: "error", error: error instanceof Error ? error.message : String(error) });
  }
});

// Reads a code snippet from the `local-git` integration's configured folder — used by the Work Item
// AI Note "Insert code reference" action to test code-location memos without a real GitHub connection.
app.get("/api/local-git/file", async (request, reply) => {
  const { path: filePath, start, end } = request.query as { path?: string; start?: string; end?: string };
  if (!filePath) return reply.code(400).send({ error: "Query param `path` is required." });
  try {
    const snippet = await localGitClient.getFileSnippet(
      filePath,
      start ? Number(start) : undefined,
      end ? Number(end) : undefined,
    );
    return snippet;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(400).send({ error: message });
  }
});

// Local branch names matching a work item key (e.g. "PROJ-12"), for the work item Development tab
// when Local Git is the chosen source — the local-git equivalent of GitHub's "Branches" section.
app.get("/api/local-git/branches", async (request, reply) => {
  const { q } = request.query as { q?: string };
  try {
    return { branches: await localGitClient.listBranches(q) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Git Control — which git backend (GitHub or Local Git) the work item Development tab shows by
// default. A workspace-wide preference, not a per-provider credential, so it lives in the small
// `app_settings` table rather than `credentials`.
const GIT_CONTROL_SETTINGS_ID = "git-control";

app.get("/api/settings/git-control", async () => {
  const stored = await appSettingsStore.get<{ defaultSource?: GitControlDefaultSource }>(GIT_CONTROL_SETTINGS_ID);
  return { defaultSource: stored?.defaultSource ?? "github" };
});

app.put("/api/settings/git-control", async (request, reply) => {
  const { defaultSource } = (request.body as { defaultSource?: string } | undefined) ?? {};
  if (!defaultSource || !GIT_CONTROL_PROVIDER_IDS.includes(defaultSource as IntegrationProviderId))
    return reply.code(400).send({ error: `\`defaultSource\` must be one of: ${GIT_CONTROL_PROVIDER_IDS.join(", ")}` });
  await appSettingsStore.set(GIT_CONTROL_SETTINGS_ID, { defaultSource });
  return { status: "success", defaultSource };
});

// Jira Excel import — an alternative to the live `/rest/api/3/search` sync (W1) for teams that export
// their Jira board to Excel instead of granting API access, surfaced from the Work Items screen. Rows
// are normalized to the same shape as the live sync and upserted into `tickets` keyed by issue
// key, so a re-import or a later live sync of the same issues updates the existing row rather than
// duplicating it. Parsing + upserting a real export runs in the background (see jiraImportJobs.ts) —
// this route only reads the upload and returns a job id; the client polls the route below for status.
app.post("/api/tickets/import-excel", async (request, reply) => {
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: "No file uploaded." });

  let buffer: Buffer;
  try {
    buffer = await file.toBuffer();
  } catch {
    return reply.code(400).send({ error: "The uploaded file is too large or could not be read." });
  }

  const job = jiraImportJobs.create();
  setImmediate(async () => {
    try {
      const { tickets, skipped } = parseJiraExcelImport(buffer);
      await services.ticketStore.upsertTickets(tickets);
      await db
        .insert(connectorStatus)
        .values({ provider: "jira", lastSyncAt: new Date(), lastSuccess: true, lastError: null })
        .onConflictDoUpdate({
          target: connectorStatus.provider,
          set: { lastSyncAt: new Date(), lastSuccess: true, lastError: null },
        });
      jiraImportJobs.complete(job.id, { imported: tickets.length, skipped });
    } catch (error) {
      jiraImportJobs.fail(job.id, error instanceof Error ? error.message : String(error));
    }
  });

  return reply.code(202).send(job);
});

app.get("/api/tickets/import-excel/:jobId", async (request, reply) => {
  const { jobId } = request.params as { jobId: string };
  const job = jiraImportJobs.get(jobId);
  if (!job) return reply.code(404).send({ error: "Unknown import job." });
  return job;
});

// Backs the Jira data view on the Work Items screen — tickets written by both the live sync (W1) and the
// Excel import above, merged by issue key.
app.get("/api/tickets", async (request) => {
  const { provider, projectKey, status, priority, assignee } = request.query as Record<string, string | undefined>;
  const items = await services.ticketStore.queryTickets({ provider, projectKey, status, priority, assignee });
  if (items.length === 0) return { items };

  // Tags each ticket with the work item it was already converted to (if any), matched the same way
  // convertTicketsToWorkItems() matches — on (externalProvider, externalKey) — so the "Jira data" table
  // can show a Converted/Not converted status instead of the user having to guess and re-click Convert.
  const converted = await db
    .select({ id: workItems.id, provider: workItems.externalProvider, key: workItems.externalKey })
    .from(workItems)
    .where(
      and(
        inArray(
          workItems.externalKey,
          items.map((item) => item.externalKey),
        ),
        inArray(workItems.externalProvider, [...new Set(items.map((item) => item.provider))]),
      ),
    );
  const convertedByKey = new Map(converted.map((row) => [`${row.provider}|${row.key}`, row.id]));

  return {
    items: items.map((item) => ({
      ...item,
      convertedWorkItemId: convertedByKey.get(`${item.provider}|${item.externalKey}`),
    })),
  };
});

// Read-only "what would happen" preview ahead of the real convert below — the Jira Sync screen's
// "Preview changes" button, so a silent overwrite (conversion always replaces description/labels/
// cycle/module/due date/story points, only title/status/priority go through a three-way merge) is
// visible before it happens, not just after.
app.post("/api/tickets/convert-to-work-items/preview", async (request, reply) => {
  const { ids } = (request.body as { ids?: string[] } | undefined) ?? {};
  if (!ids || ids.length === 0) return reply.code(400).send({ error: "Body must include a non-empty `ids` array." });

  const allTickets = await services.ticketStore.queryTickets({});
  const idSet = new Set(ids);
  const tickets = allTickets.filter((ticket) => idSet.has(ticket.id));
  if (tickets.length === 0) return reply.code(404).send({ error: "No matching tickets found." });

  const previews = await previewTicketConversions(db, tickets);
  return { previews };
});

// Converting a Jira ticket into a real platform work item is a deliberate, user-picked action (not
// automatic on import/sync) — the Jira data dialog lets the user select which rows to convert. Matched
// on (provider, externalKey) via jiraTicketToWorkItem.ts, so re-converting an already-converted ticket
// updates its work item rather than duplicating it.
app.post("/api/tickets/convert-to-work-items", async (request, reply) => {
  const { ids, projectId } = (request.body as { ids?: string[]; projectId?: string } | undefined) ?? {};
  if (!ids || ids.length === 0) return reply.code(400).send({ error: "Body must include a non-empty `ids` array." });

  const allTickets = await services.ticketStore.queryTickets({});
  const idSet = new Set(ids);
  const tickets = allTickets.filter((ticket) => idSet.has(ticket.id));
  if (tickets.length === 0) return reply.code(404).send({ error: "No matching tickets found." });

  const { created, updated } = await convertTicketsToWorkItems(db, tickets, projectId);
  return { status: "success", created, updated };
});

// The Jira Sync screen's "Sprints" and "Modules" sections — a deliberate, reviewable pre-step ahead of
// converting work items: turns the distinct Sprint (or Fix Version/s) values found across the imported
// tickets straight into cycles (or modules) in `projectId`, so a messy/duplicate Jira name can be
// caught and fixed before it lands as a cycle/module, rather than only ever being created silently as a
// side effect of "Convert to work items" (which still happens too, as a fallback — see
// jiraTicketToWorkItem.ts's `mapTicketToPlanningGroups`).
app.post("/api/tickets/convert-to-cycles", async (request, reply) => {
  const { names, projectId } = (request.body as { names?: string[]; projectId?: string } | undefined) ?? {};
  if (!names || names.length === 0) return reply.code(400).send({ error: "Body must include a non-empty `names` array." });
  if (!projectId) return reply.code(400).send({ error: "Body must include `projectId`." });

  const result = await convertNamesToPlanningGroups(db, projectId, "cycle", names);
  return { status: "success", ...result };
});

app.post("/api/tickets/convert-to-modules", async (request, reply) => {
  const { names, projectId } = (request.body as { names?: string[]; projectId?: string } | undefined) ?? {};
  if (!names || names.length === 0) return reply.code(400).send({ error: "Body must include a non-empty `names` array." });
  if (!projectId) return reply.code(400).send({ error: "Body must include `projectId`." });

  const result = await convertNamesToPlanningGroups(db, projectId, "module", names);
  return { status: "success", ...result };
});

// Left behind by the three-way merge in convertTicketsToWorkItems() above when both the app and Jira
// changed the same field since the last sync — surfaced on the Jira Sync screen's "Resolve sync
// conflicts" card, never auto-resolved.
app.get("/api/tickets/conflicts", async (request, reply) => {
  const { projectId } = request.query as Record<string, string | undefined>;
  if (!projectId) return reply.code(400).send({ error: "Query must include `projectId`." });
  const conflicts = await ticketSyncConflictStore.listByProject(projectId);
  return { conflicts };
});

app.post("/api/tickets/conflicts/:id/resolve", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { choice } = (request.body as { choice?: "app" | "jira" } | undefined) ?? {};
  if (choice !== "app" && choice !== "jira") return reply.code(400).send({ error: 'Body must include `choice` of "app" or "jira".' });
  try {
    await ticketSyncConflictStore.resolve(id, choice);
    return { status: "success" };
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

await app.listen({ port: env.port, host: "0.0.0.0" });
