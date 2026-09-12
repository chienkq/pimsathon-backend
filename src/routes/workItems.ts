import { WORK_ITEM_STATUSES } from "@chienkq/workflow-core";
import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";
import { deleteWorkItemFromAdminUi, upsertWorkItemFromAdminUi, type AdminUiWorkItemFields } from "../store/adminUiSync.js";

export function registerWorkItemRoutes(app: FastifyInstance, ctx: BackendContext) {
  app.get("/api/work-items", async () => ({ workItems: await ctx.services.workItemStore.list({}) }));

  // One work item's full record, `jiraRaw`/`aiNote` included — used by the `recall_workitem` agent
  // tool (see seeds/seedAuthenticityAgent.ts) so an AI Agent can fetch a work item's raw Jira payload
  // itself instead of only seeing whatever subset a workflow node's context already handed it.
  app.get("/api/work-items/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const item = await ctx.services.workItemStore.get(id);
    if (!item) return reply.code(404).send({ error: `Unknown work item: ${id}` });
    return { workItem: item };
  });

  // Latest result from the "Analyze Work Item Health" workflow for one work item — null until that
  // workflow has run at least once for this item (see store/analysisResultStore.ts / seeds/seedAnalyzeWorkflows.ts).
  app.get("/api/work-items/:id/health", async (request) => {
    const { id } = request.params as { id: string };
    const [latest] = await ctx.services.analysisResultStore.queryLatest("workItem", id, 1);
    return { health: latest ?? null };
  });

  // admin-ui's own write path — upsert-by-id, scoped to the fields admin-ui owns (see store/adminUiSync.ts).
  // admin-ui assigns `id`/`number` itself and this never overrides them, so identity always stays
  // admin-ui's local reducer's call, not this backend's.
  app.put("/api/work-items/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<AdminUiWorkItemFields> | undefined;
    if (!body || body.projectId === undefined || body.number === undefined || !body.title) {
      return reply.code(400).send({ error: "Body must include at least projectId, number, and title." });
    }
    try {
      await upsertWorkItemFromAdminUi(ctx.db, {
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
    await deleteWorkItemFromAdminUi(ctx.db, id);
    return { status: "success" };
  });

  app.patch("/api/work-items/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status?: string };
    if (!status || !WORK_ITEM_STATUSES.includes(status as (typeof WORK_ITEM_STATUSES)[number])) {
      return reply.code(400).send({ error: `Body must include a valid \`status\`: ${WORK_ITEM_STATUSES.join(", ")}.` });
    }
    try {
      const updated = await ctx.services.workItemStore.moveStatus(id, status as (typeof WORK_ITEM_STATUSES)[number]);
      return { workItem: updated };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
