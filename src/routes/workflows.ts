import type { WorkflowDefinition, WorkflowNodeDefinition } from "@chienkq/workflow-core";
import { workflowRuns } from "@chienkq/workflow-db";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";
import { cancelWorkflowRun, ensureWorkflowRow, resolveWorkflow, runWorkflow, startWorkflowRun } from "../services/workflow/runner.js";

export function registerWorkflowRoutes(app: FastifyInstance, ctx: BackendContext) {
  // User-authored workflows (the editor's own CRUD), backed by the same `workflows` table the
  // pre-registered code workflows below live in — distinct from `/api/workflows/:id/run`, which only
  // runs the fixed set of built-in workflows registered at startup, not arbitrary saved ones.
  app.get("/api/workflows", async (request) => {
    const { inputNodeType } = request.query as { inputNodeType?: string };
    const workflows = inputNodeType
      ? await ctx.workflowStore.listByInputNodeType(inputNodeType)
      : await ctx.workflowStore.list();
    return { workflows };
  });

  app.get("/api/workflows/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workflow = await ctx.workflowStore.get(id);
    if (!workflow) return reply.code(404).send({ error: `Unknown workflow: ${id}` });
    return { workflow };
  });

  app.post("/api/workflows", async (request, reply) => {
    const { name, nodes } = (request.body as { name?: string; nodes?: WorkflowNodeDefinition[] } | undefined) ?? {};
    if (!name) return reply.code(400).send({ error: "Body must include `name`." });
    const workflow = await ctx.workflowStore.create(name, nodes);
    return reply.code(201).send({ workflow });
  });

  app.put("/api/workflows/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<WorkflowDefinition> | undefined;
    if (!body || !body.name || !body.nodes || !body.connections) {
      return reply.code(400).send({ error: "Body must include at least name, nodes, and connections." });
    }
    try {
      const workflow = await ctx.workflowStore.save({ ...body, id } as WorkflowDefinition);
      return { workflow };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/workflows/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await ctx.workflowStore.remove(id);
      return { status: "success" };
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/workflows/:id/duplicate", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const workflow = await ctx.workflowStore.duplicate(id);
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
      const workflow = await ctx.workflowStore.setActive(id, active);
      return { workflow };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/workflows/:id/run", async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = (
      ctx.registeredWorkflows as Record<string, (typeof ctx.registeredWorkflows)[keyof typeof ctx.registeredWorkflows]>
    )[id];
    const body = (request.body as { workflow?: WorkflowDefinition; uploadId?: string } | undefined) ?? {};
    let adHocWorkflow: WorkflowDefinition | undefined;
    try {
      adHocWorkflow = body.uploadId
        ? ctx.chunkedUploads.finish<{ workflow?: WorkflowDefinition }>(body.uploadId).workflow
        : body.workflow;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }

    // Ad-hoc run (the editor's "Run" button, possibly with unsaved edits) takes precedence over both
    // the fixed registered set and whatever's currently saved for this id; falls back to a saved
    // user-authored workflow (from the `/api/workflows` CRUD routes) when no body is given.
    const workflow =
      adHocWorkflow ?? (entry ? await resolveWorkflow(entry.workflow) : undefined) ?? (await ctx.workflowStore.get(id));
    if (!workflow) return reply.code(404).send({ error: `Unknown workflow: ${id}` });

    try {
      if (adHocWorkflow) await ensureWorkflowRow(ctx.db, adHocWorkflow);
      const { runId } = await startWorkflowRun(ctx.db, workflow, ctx.services, entry?.connectorProvider);
      return reply.code(202).send({ status: "running", runId });
    } catch (error) {
      return reply.code(500).send({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Stop button — cooperatively cancels a still-running manual run (see `cancelWorkflowRun`). Returns
  // 404 once the run has already settled (or for an unknown id), since there's nothing left to cancel.
  app.post("/api/workflows/:id/runs/:runId/cancel", async (request, reply) => {
    const { runId } = request.params as { id: string; runId: string };
    if (!cancelWorkflowRun(runId)) return reply.code(404).send({ error: `No in-flight run: ${runId}` });
    return { ok: true };
  });

  // Run history for the editor's Run Logs panel — every `runWorkflow` call (scheduled, webhook, or
  // manual) already writes a row to `workflow_runs`, this just exposes it. List omits `output` (can
  // be large and isn't needed for the row view); detail includes it for the timeline.
  app.get("/api/workflows/:id/runs", async (request) => {
    const { id } = request.params as { id: string };
    const rows = await ctx.db
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
    const [row] = await ctx.db
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
    const entry = (
      ctx.registeredWorkflows as Record<string, (typeof ctx.registeredWorkflows)[keyof typeof ctx.registeredWorkflows]>
    )[workflowId];
    const workflow = (entry ? await resolveWorkflow(entry.workflow) : undefined) ?? (await ctx.workflowStore.get(workflowId));
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
      const result = await runWorkflow(ctx.db, workflow, { ...ctx.services, webhookRequest }, "webhook", entry?.connectorProvider);
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
}
