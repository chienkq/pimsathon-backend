import {
  getIntegrationProvider,
  INTEGRATION_PROVIDERS,
  listNodeTypeMetas,
  WORK_ITEM_STATUSES,
  type IntegrationProviderId,
  type WorkflowDefinition,
} from "@chienkq/workflow-core";
import {
  alerts,
  branches,
  connectorStatus,
  createDb,
  githubIssues,
  members,
  projects,
  pullRequests,
  repositories,
  widgets,
} from "@chienkq/workflow-db";
import { desc, eq } from "drizzle-orm";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createAlertStore } from "./alertStore.js";
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
import { createFactStore } from "./factStore.js";
import { createGitCacheStore } from "./gitCacheStore.js";
import { createGitClient } from "./githubClient.js";
import { createGmailClient } from "./gmailClient.js";
import { createJiraClient } from "./jiraClient.js";
import { createOutlookClient } from "./outlookClient.js";
import { ensureWorkflowRow, runWorkflow, type RunnerServices } from "./runner.js";
import { scheduleWorkflow } from "./scheduler.js";
import { createSlackClient } from "./slackClient.js";
import { createTeamsClient } from "./teamsClient.js";
import { createWorkflowStore } from "./workflowStore.js";
import { seedPlatformData } from "./seedPlatformData.js";
import {
  ALERT_ENGINE_WORKFLOW_ID,
  buildAlertEngineWorkflow,
  buildBugMetricsWorkflow,
  buildGitHubSyncWorkflow,
  buildJiraSyncWorkflow,
  buildMilestoneTrackerWorkflow,
  buildTeamWorkloadWorkflow,
  BUG_METRICS_WORKFLOW_ID,
  GITHUB_SYNC_WORKFLOW_ID,
  JIRA_SYNC_WORKFLOW_ID,
  MILESTONE_TRACKER_WORKFLOW_ID,
  TEAM_WORKLOAD_WORKFLOW_ID,
} from "./seedWorkflow.js";
import { createPlanningGroupStore } from "./planningGroupStore.js";
import { getProjectHealth } from "./projectHealth.js";
import { createWidgetStore } from "./widgetStore.js";
import { createWorkItemStore } from "./workItemStore.js";

const db = createDb(env.databaseUrl);
const workflowStore = createWorkflowStore(db);
const credentialStore = createCredentialStore(db);
const services: RunnerServices = {
  jiraClient: createJiraClient({ baseUrl: env.jiraBaseUrl, email: env.jiraEmail, apiToken: env.jiraApiToken }),
  factStore: createFactStore(db),
  alertStore: createAlertStore(db),
  workItemStore: createWorkItemStore(db),
  widgetStore: createWidgetStore(db),
  planningGroupStore: createPlanningGroupStore(db),
  gitClient: createGitClient({ token: env.githubToken }),
  gitCacheStore: createGitCacheStore(db),
};

await seedPlatformData(db);

/** Registered workflows, keyed by id — `connectorProvider` is set only for connector-sync workflows (W1, W3), not rule/metric workflows (W8-W10, W11). */
const registeredWorkflows = {
  [JIRA_SYNC_WORKFLOW_ID]: { workflow: buildJiraSyncWorkflow(), cron: "*/15 * * * *", connectorProvider: "jira" },
  [GITHUB_SYNC_WORKFLOW_ID]: { workflow: buildGitHubSyncWorkflow(), cron: "*/15 * * * *", connectorProvider: "github" },
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
} as const;

for (const { workflow, cron, connectorProvider } of Object.values(registeredWorkflows)) {
  await ensureWorkflowRow(db, workflow);
  scheduleWorkflow(db, workflow, cron, services, connectorProvider);
}

const app = Fastify({ logger: true });

// Dev-only permissive CORS — admin-ui (Vite, a different origin/port) calls this API directly from
// the browser. Tighten to an explicit allowlist before this backend is ever exposed beyond localhost.
await app.register(cors, { origin: true });

app.get("/health", async () => ({ status: "ok" }));

// The Add-Node panel's node type list — metadata only (no `execute`, functions can't cross HTTP),
// stripped from the same `nodeTypeRegistry` the runner executes nodes against.
app.get("/api/node-types", async () => ({ nodeTypes: listNodeTypeMetas() }));

// User-authored workflows (the editor's own CRUD), backed by the same `workflows` table the
// pre-registered code workflows below live in — distinct from `/api/workflows/:id/run`, which only
// runs the fixed set of built-in workflows registered at startup, not arbitrary saved ones.
app.get("/api/workflows", async () => ({ workflows: await workflowStore.list() }));

app.get("/api/workflows/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const workflow = await workflowStore.get(id);
  if (!workflow) return reply.code(404).send({ error: `Unknown workflow: ${id}` });
  return { workflow };
});

app.post("/api/workflows", async (request, reply) => {
  const { name } = (request.body as { name?: string } | undefined) ?? {};
  if (!name) return reply.code(400).send({ error: "Body must include `name`." });
  const workflow = await workflowStore.create(name);
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

app.delete("/api/workflows/:id", async (request) => {
  const { id } = request.params as { id: string };
  await workflowStore.remove(id);
  return { status: "success" };
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
  const workflow = adHocWorkflow ?? entry?.workflow ?? (await workflowStore.get(id));
  if (!workflow) return reply.code(404).send({ error: `Unknown workflow: ${id}` });

  try {
    if (adHocWorkflow) await ensureWorkflowRow(db, adHocWorkflow);
    const result = await runWorkflow(db, workflow, services, "manual", entry?.connectorProvider);
    if (result.status === "error") {
      return reply.code(502).send({
        status: result.status,
        nodeResults: result.nodeResults,
        error: "Workflow run finished with a node error — see nodeResults for details.",
      });
    }
    return { status: result.status, nodeResults: result.nodeResults };
  } catch (error) {
    return reply.code(500).send({ status: "error", error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/alerts", async () => {
  const rows = await db.select().from(alerts).orderBy(desc(alerts.updatedAt)).limit(200);
  return { alerts: rows };
});

// Platform data — the same tables the `workItem` node reads/writes. admin-ui's `DemoProvider`
// fetches these three on load and replaces its local projects/members/workItems with them (see
// admin-ui's `state/store.tsx`), which is what makes the two sides agree on identity.
app.get("/api/projects", async () => ({ projects: await db.select().from(projects) }));

app.get("/api/members", async () => ({ members: await db.select().from(members) }));

app.get("/api/work-items", async () => ({ workItems: await services.workItemStore.list({}) }));

// admin-ui's own write path — upsert-by-id, scoped to the fields admin-ui owns (see adminUiSync.ts
// for why `cycleId`/`moduleIds` are excluded). admin-ui assigns `id`/`number` itself and this never
// overrides them, so identity always stays admin-ui's local reducer's call, not this backend's.
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

// Real GitHub data, synced by W3 (GitHub Sync) into Postgres — read-only for now, see git.ts /
// githubClient.ts for the write actions (Create Issue/Branch/PR) that aren't wired up yet.
app.get("/api/repositories", async () => ({ repositories: await db.select().from(repositories) }));

app.get("/api/repositories/:id/branches", async (request) => {
  const { id } = request.params as { id: string };
  return { branches: await db.select().from(branches).where(eq(branches.repositoryId, id)) };
});

app.get("/api/repositories/:id/pull-requests", async (request) => {
  const { id } = request.params as { id: string };
  return { pullRequests: await db.select().from(pullRequests).where(eq(pullRequests.repositoryId, id)) };
});

app.get("/api/repositories/:id/issues", async (request) => {
  const { id } = request.params as { id: string };
  return { issues: await db.select().from(githubIssues).where(eq(githubIssues.repositoryId, id)) };
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

await app.listen({ port: env.port, host: "0.0.0.0" });
