import { widgets } from "@chienkq/workflow-db";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";

export function registerWidgetRoutes(app: FastifyInstance, ctx: BackendContext) {
  app.get("/api/widgets", async () => ({ widgets: await ctx.db.select().from(widgets).orderBy(desc(widgets.updatedAt)) }));

  app.get("/api/widgets/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [widget] = await ctx.db.select().from(widgets).where(eq(widgets.widgetId, id));
    if (!widget) return reply.code(404).send({ error: `Unknown widget: ${id}` });
    return { widget };
  });
}
