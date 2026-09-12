import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";
import type { AiAgentInput } from "../store/aiAgentStore.js";

function parseAiAgentInput(body: unknown): AiAgentInput {
  const input = (body ?? {}) as Partial<AiAgentInput>;
  if (!input.name?.trim()) throw new Error("Name is required.");
  const maxToolIterations = Number(input.maxToolIterations);
  return {
    name: input.name.trim(),
    markdown: input.markdown ?? "",
    llmConfigId: input.llmConfigId || undefined,
    toolIds: Array.isArray(input.toolIds) ? input.toolIds.filter((id): id is string => typeof id === "string") : [],
    maxToolIterations: Number.isFinite(maxToolIterations) && maxToolIterations > 0 ? Math.floor(maxToolIterations) : 8,
  };
}

// AI Agents (Automation sidebar) — a Markdown "system prompt" + an assigned LLM Config + assigned
// Tools, referenced by the "Send Message to Agent" node via a live dropdown (unlike the older "Send
// Message to AI Agent" node, which points straight at an `llm_configs` row by free-typed name).
export function registerAiAgentRoutes(app: FastifyInstance, ctx: BackendContext) {
  app.get("/api/ai-agents", async () => ({ agents: await ctx.aiAgentStore.list() }));

  app.get("/api/ai-agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = await ctx.aiAgentStore.get(id);
    if (!agent) return reply.code(404).send({ error: `Unknown AI Agent: ${id}` });
    return { agent };
  });

  app.post("/api/ai-agents", async (request, reply) => {
    try {
      const agent = await ctx.aiAgentStore.create(parseAiAgentInput(request.body));
      return reply.code(201).send({ agent });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/api/ai-agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await ctx.aiAgentStore.get(id))) return reply.code(404).send({ error: `Unknown AI Agent: ${id}` });
    try {
      const agent = await ctx.aiAgentStore.update(id, parseAiAgentInput(request.body));
      return { agent };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/ai-agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await ctx.aiAgentStore.get(id))) return reply.code(404).send({ error: `Unknown AI Agent: ${id}` });
    await ctx.aiAgentStore.remove(id);
    return { status: "success" };
  });
}
