import { alerts } from "@chienkq/workflow-db";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";

export function registerAlertRoutes(app: FastifyInstance, ctx: BackendContext) {
  app.get("/api/alerts", async (request) => {
    const { workItemId } = request.query as { workItemId?: string };
    const rows = await ctx.db
      .select()
      .from(alerts)
      .where(workItemId ? eq(alerts.workItemId, workItemId) : undefined)
      .orderBy(desc(alerts.updatedAt))
      .limit(200);
    return { alerts: rows };
  });
}
