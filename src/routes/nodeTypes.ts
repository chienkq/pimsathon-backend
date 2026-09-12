import { executeSingleNode, listNodeTypeMetas, type NodeExecuteInputGroup, type NodeExecutionData } from "@chienkq/workflow-core";
import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";

export function registerNodeTypeRoutes(app: FastifyInstance, ctx: BackendContext) {
  // The Add-Node panel's node type list — metadata only (no `execute`, functions can't cross HTTP),
  // stripped from the same `nodeTypeRegistry` the runner executes nodes against.
  app.get("/api/node-types", async () => ({ nodeTypes: listNodeTypeMetas() }));

  // The NDV "Execute" button — runs one node type in isolation against the real backend services
  // (e.g. the workItem node's Jira/DB-backed CRUD), bypassing the graph. `input` is whatever the
  // editor already resolved client-side from the upstream node's last result.
  app.post("/api/node-types/:type/execute", async (request, reply) => {
    const { type } = request.params as { type: string };
    const body =
      (request.body as
        | {
            parameters?: Record<string, unknown>;
            input?: NodeExecutionData[];
            inputs?: NodeExecuteInputGroup[];
            nodeContext?: Record<string, Record<string, unknown>>;
            uploadId?: string;
          }
        | undefined) ?? {};
    let parameters: Record<string, unknown> | undefined;
    let input: NodeExecutionData[] | undefined;
    let inputs: NodeExecuteInputGroup[] | undefined;
    let nodeContext: Record<string, Record<string, unknown>> | undefined;
    try {
      if (body.uploadId) {
        const resolved = ctx.chunkedUploads.finish<{
          parameters?: Record<string, unknown>;
          input?: NodeExecutionData[];
          inputs?: NodeExecuteInputGroup[];
          nodeContext?: Record<string, Record<string, unknown>>;
        }>(body.uploadId);
        parameters = resolved.parameters;
        input = resolved.input;
        inputs = resolved.inputs;
        nodeContext = resolved.nodeContext;
      } else {
        parameters = body.parameters;
        input = body.input;
        inputs = body.inputs;
        nodeContext = body.nodeContext;
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }

    try {
      const result = await executeSingleNode(
        type,
        parameters ?? {},
        input ?? [],
        ctx.services as unknown as Record<string, unknown>,
        inputs,
        nodeContext
      );
      if (result.status === "error") return reply.code(502).send(result);
      return result;
    } catch (error) {
      return reply.code(500).send({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  });
}
