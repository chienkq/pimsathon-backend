import { WORK_ITEM_STATUSES } from "@chienkq/workflow-core";
import {
  alerts,
  branches,
  createDb,
  githubIssues,
  members,
  projects,
  pullRequests,
  repositories,
  widgets,
  workItems,
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
import { env } from "./env.js";
import { createFactStore } from "./factStore.js";
import { createGitCacheStore } from "./gitCacheStore.js";
import { createGitClient } from "./githubClient.js";
import { createJiraClient } from "./jiraClient.js";
import { ensureWorkflowRow, runWorkflow, type RunnerServices } from "./runner.js";
import { scheduleWorkflow } from "./scheduler.js";
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

app.post("/api/workflows/:id/run", async (request, reply) => {
  const { id } = request.params as { id: string };
  const entry = (registeredWorkflows as Record<string, (typeof registeredWorkflows)[keyof typeof registeredWorkflows]>)[
    id
  ];
  if (!entry) return reply.code(404).send({ error: `Unknown workflow: ${id}` });

  try {
    const status = await runWorkflow(db, entry.workflow, services, "manual", entry.connectorProvider);
    if (status === "error") {
      return reply
        .code(502)
        .send({ status, error: "Workflow run finished with a node error — see workflow_runs.output for details." });
    }
    return { status };
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

await app.listen({ port: env.port, host: "0.0.0.0" });
