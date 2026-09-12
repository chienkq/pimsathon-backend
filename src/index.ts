import {
  getIntegrationProvider,
  INTEGRATION_PROVIDERS,
  listNodeTypeMetas,
  WORK_ITEM_STATUSES,
  type IntegrationProviderId,
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
import { createCredentialStore } from "./credentialStore.js";
import { env } from "./env.js";
import { createTicketStore } from "./ticketStore.js";
import { createTicketSyncConflictStore } from "./ticketSyncConflictStore.js";
import { createGitCacheStore } from "./gitCacheStore.js";
import { createGitClientFromCredentials, listAccountRepositories } from "./githubClient.js";
import { createGmailClient } from "./gmailClient.js";
import { createJiraClientFromCredentials } from "./jiraClient.js";
import { parseJiraExcelImport } from "./jiraExcelImport.js";
import { convertTicketsToWorkItems } from "./jiraTicketToWorkItem.js";
import { createJiraImportJobStore } from "./jiraImportJobs.js";
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
  buildAnalyzeCycleWorkflow,
  buildAnalyzeModuleWorkflow,
  buildAnalyzeWorkItemHealthWorkflow,
} from "./seedAnalyzeWorkflows.js";
import { createPlanningGroupStore } from "./planningGroupStore.js";
import { getProjectHealth } from "./projectHealth.js";
import { createWidgetStore } from "./widgetStore.js";
import { createWorkItemStore } from "./workItemStore.js";

const db = createDb(env.databaseUrl);
const workflowStore = createWorkflowStore(db);
const credentialStore = createCredentialStore(db);
const jiraImportJobs = createJiraImportJobStore();
const ticketSyncConflictStore = createTicketSyncConflictStore(db);
const services: RunnerServices = {
  jiraClient: createJiraClientFromCredentials(credentialStore),
  ticketStore: createTicketStore(db),
  alertStore: createAlertStore(db),
  workItemStore: createWorkItemStore(db),
  widgetStore: createWidgetStore(db),
  planningGroupStore: createPlanningGroupStore(db),
  gitClient: createGitClientFromCredentials(credentialStore),
  gitCacheStore: createGitCacheStore(db),
  analysisResultStore: createAnalysisResultStore(db),
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

app.get("/api/members", async () => ({ members: await db.select().from(members) }));

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
// GitHub data today. `projectId: null` disconnects.
app.patch("/api/repositories/:id/connect", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { projectId } = request.body as { projectId: string | null | undefined };
  if (projectId === undefined)
    return reply.code(400).send({ error: "Body must include `projectId` (string or null)." });
  await db.update(repositories).set({ projectId }).where(eq(repositories.id, id));
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
