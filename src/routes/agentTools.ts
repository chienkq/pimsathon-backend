import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";
import type { AgentToolInput } from "../store/agentToolStore.js";
import { runAgentTool } from "../services/agents/agentToolRunner.js";

function parseAgentToolInput(body: unknown): AgentToolInput {
  const input = (body ?? {}) as Partial<AgentToolInput>;
  const name = input.name?.trim() ?? "";
  if (!name) throw new Error("Name is required.");
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error(
      "Name must look like a function name (letters, digits, _ or -, not starting with a digit) — it's sent to the model as the tool's callable name.",
    );
  }
  return {
    name,
    description: input.description?.trim() ?? "",
    parametersSchema: (input.parametersSchema as Record<string, unknown> | undefined) ?? { type: "object", properties: {} },
    code: input.code ?? "",
  };
}

// Tools (Automation sidebar) — a named JS function ("agent_tools" row) an AI Agent may call
// mid-conversation. `name` doubles as the callable name sent to the provider, so it's validated to
// look like one.
export function registerAgentToolRoutes(app: FastifyInstance, ctx: BackendContext) {
  app.get("/api/agent-tools", async () => ({ tools: await ctx.agentToolStore.list() }));

  app.get("/api/agent-tools/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tool = await ctx.agentToolStore.get(id);
    if (!tool) return reply.code(404).send({ error: `Unknown tool: ${id}` });
    return { tool };
  });

  app.post("/api/agent-tools", async (request, reply) => {
    try {
      const tool = await ctx.agentToolStore.create(parseAgentToolInput(request.body));
      return reply.code(201).send({ tool });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/api/agent-tools/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await ctx.agentToolStore.get(id))) return reply.code(404).send({ error: `Unknown tool: ${id}` });
    try {
      const tool = await ctx.agentToolStore.update(id, parseAgentToolInput(request.body));
      return { tool };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/agent-tools/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await ctx.agentToolStore.get(id))) return reply.code(404).send({ error: `Unknown tool: ${id}` });
    await ctx.agentToolStore.remove(id);
    return { status: "success" };
  });

  // Quick "Run" button on the Tool editor — executes the tool's JS against sample params without an
  // actual agent conversation, so a tool author can smoke-test it in isolation.
  app.post("/api/agent-tools/:id/test", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tool = await ctx.agentToolStore.get(id);
    if (!tool) return reply.code(404).send({ error: `Unknown tool: ${id}` });
    const { params } = (request.body as { params?: Record<string, unknown> } | undefined) ?? {};
    try {
      const result = await runAgentTool(tool.code, params ?? {});
      return { status: "success", result };
    } catch (error) {
      return reply.code(400).send({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  });
}
