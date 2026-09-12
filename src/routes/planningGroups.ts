import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";
import {
  deletePlanningGroupFromAdminUi,
  upsertPlanningGroupFromAdminUi,
  type AdminUiPlanningGroupFields,
} from "../store/adminUiSync.js";

// Cycles/modules — same shape as admin-ui's own `PlanningGroup` (`kind` discriminates the two, see
// schema.ts). admin-ui replaces its local cycles/modules with this list wholesale on load, same as
// projects/members/workItems, so `PATCH .../status`-style partial writes aren't needed here — a
// full upsert-by-id is enough (see store/adminUiSync.ts's `upsertPlanningGroupFromAdminUi`).
export function registerPlanningGroupRoutes(app: FastifyInstance, ctx: BackendContext) {
  app.get("/api/planning-groups", async () => ({ planningGroups: await ctx.services.planningGroupStore.list({}) }));

  app.put("/api/planning-groups/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<AdminUiPlanningGroupFields> | undefined;
    if (!body || !body.projectId || !body.kind || !body.name) {
      return reply.code(400).send({ error: "Body must include at least projectId, kind, and name." });
    }
    try {
      await upsertPlanningGroupFromAdminUi(ctx.db, {
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
    await deletePlanningGroupFromAdminUi(ctx.db, id);
    return { status: "success" };
  });
}
