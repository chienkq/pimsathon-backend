import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";

// Start/append for a chunked upload (see lib/chunkedUploads.ts) — lets a client with a large payload
// (an ad-hoc workflow definition, or a git node's "Read Project Files" output) send it as many small
// requests instead of hitting the body-size limit on the endpoint that actually consumes it.
// `/api/workflows/:id/run` and `/api/node-types/:type/execute` accept `{ uploadId }` in place of
// their normal inline body.
export function registerUploadRoutes(app: FastifyInstance, ctx: BackendContext) {
  app.post("/api/uploads", async () => ({ uploadId: ctx.chunkedUploads.start() }));

  app.post("/api/uploads/:id/chunks", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { index, data } = (request.body as { index?: number; data?: string } | undefined) ?? {};
    if (typeof index !== "number" || typeof data !== "string") {
      return reply.code(400).send({ error: "chunk body must be { index: number, data: string }" });
    }
    try {
      ctx.chunkedUploads.appendChunk(id, index, data);
      return { ok: true };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
