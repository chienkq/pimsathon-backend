import { getLlmProvider, LLM_PROVIDERS, type LlmConfigKind, type LlmProviderId } from "@chienkq/workflow-core";
import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";
import type { LlmConfigInput } from "../store/llmConfigStore.js";
import { listLlmModels, testLlmConfig } from "../integrations/llm/llmProviderTest.js";

/**
 * `keepExistingApiKey` is true when updating a config that already has a stored key and the request
 * left `apiKey` blank — that means "leave it as-is", not "this provider needs no key", so the
 * required-field check is skipped for just that case.
 */
function parseLlmConfigInput(body: unknown, keepExistingApiKey = false): LlmConfigInput {
  const input = (body ?? {}) as Partial<LlmConfigInput> & { provider?: string; kind?: string };
  const kind: LlmConfigKind = input.kind === "embedding" ? "embedding" : "chat";
  const spec = getLlmProvider(input.provider ?? "");
  if (!spec) throw new Error(`Unknown LLM provider: ${input.provider}`);
  if (kind === "embedding" && spec.supportsEmbedding !== true) throw new Error(`${spec.displayName} has no embeddings API.`);
  if (!input.name?.trim()) throw new Error("Name is required.");
  if (!input.model?.trim()) throw new Error("Model is required.");

  const extra: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of spec.connectionFields) {
    if (field.key === "apiKey" || field.key === "baseUrl") continue;
    const value = (input.extra as Record<string, string> | undefined)?.[field.key];
    if (field.required && !value?.trim()) missing.push(field.label);
    if (value) extra[field.key] = value.trim();
  }
  // Embedding-only extras: prefixes some instruction-tuned models expect (e.g. e5's "query: "/"passage: ").
  if (kind === "embedding") {
    const embeddingExtra = input.extra as Record<string, string> | undefined;
    if (embeddingExtra?.queryPrefix) extra.queryPrefix = embeddingExtra.queryPrefix;
    if (embeddingExtra?.passagePrefix) extra.passagePrefix = embeddingExtra.passagePrefix;
  }
  const needsApiKey = spec.connectionFields.some((f) => f.key === "apiKey" && f.required);
  if (needsApiKey && !input.apiKey && !keepExistingApiKey) missing.push("API Key");
  const needsBaseUrl = spec.connectionFields.some((f) => f.key === "baseUrl" && f.required);
  if (needsBaseUrl && !input.baseUrl?.trim()) missing.push("Base URL");
  if (kind === "embedding" && !input.dimension) missing.push("Output dimension");
  if (missing.length > 0) throw new Error(`Missing required field(s): ${missing.join(", ")}`);

  return {
    name: input.name.trim(),
    kind,
    provider: spec.id as LlmProviderId,
    model: input.model.trim(),
    apiKey: input.apiKey,
    baseUrl: input.baseUrl?.trim(),
    extra,
    temperature: input.temperature ?? 0.7,
    maxTokens: input.maxTokens ?? 1024,
    topP: input.topP,
    timeoutMs: input.timeoutMs ?? 60000,
    systemPrompt: input.systemPrompt?.trim(),
    dimension: kind === "embedding" ? Number(input.dimension) : undefined,
  };
}

// LLM Settings screen (Automation sidebar) — CRUD named LLM setups (provider + model + generation
// params) that AI-flavored nodes can be pointed at. API keys are AES-256-GCM encrypted at rest
// (store/llmConfigStore.ts) and never echoed back to the client — `list`/`get` only report `hasApiKey`.
export function registerLlmConfigRoutes(app: FastifyInstance, ctx: BackendContext) {
  app.get("/api/llm-providers", async () => ({
    providers: LLM_PROVIDERS.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      description: p.description,
      color: p.color,
      connectionFields: p.connectionFields,
      defaultModel: p.defaultModel,
      modelPlaceholder: p.modelPlaceholder,
      supportsEmbedding: p.supportsEmbedding,
    })),
  }));

  app.get("/api/llm-configs", async (request) => {
    const { kind } = (request.query as { kind?: string }) ?? {};
    if (kind && kind !== "chat" && kind !== "embedding") throw new Error(`\`kind\` must be "chat" or "embedding"`);
    return { configs: await ctx.llmConfigStore.list(kind as LlmConfigKind | undefined) };
  });

  app.post("/api/llm-configs", async (request, reply) => {
    try {
      const config = await ctx.llmConfigStore.create(parseLlmConfigInput(request.body));
      return reply.code(201).send({ config });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/api/llm-configs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await ctx.llmConfigStore.get(id);
    if (!existing) return reply.code(404).send({ error: `Unknown LLM config: ${id}` });
    try {
      const config = await ctx.llmConfigStore.update(id, parseLlmConfigInput(request.body, existing.hasApiKey));
      return { config };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/llm-configs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await ctx.llmConfigStore.get(id))) return reply.code(404).send({ error: `Unknown LLM config: ${id}` });
    await ctx.llmConfigStore.remove(id);
    return { status: "success" };
  });

  app.patch("/api/llm-configs/:id/default", async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = await ctx.llmConfigStore.setDefault(id);
    if (!config) return reply.code(404).send({ error: `Unknown LLM config: ${id}` });
    return { config };
  });

  /**
   * Backs the Model field's dropdown: called on focus with whatever connection fields are filled in so
   * far (the config may not be saved yet). When editing a config whose API key was left blank
   * ("keep the current key"), `configId` lets us borrow the already-stored key instead of asking the
   * form to resend it.
   */
  app.post("/api/llm-configs/models", async (request, reply) => {
    const body = (request.body ?? {}) as {
      provider?: string;
      apiKey?: string;
      baseUrl?: string;
      extra?: Record<string, string>;
      configId?: string;
    };
    const spec = getLlmProvider(body.provider ?? "");
    if (!spec) return reply.code(400).send({ error: `Unknown LLM provider: ${body.provider}` });
    let apiKey = body.apiKey;
    if (!apiKey && body.configId) {
      const existing = await ctx.llmConfigStore.getWithSecret(body.configId);
      apiKey = existing?.apiKey;
    }
    try {
      const models = await listLlmModels(spec.id as LlmProviderId, { apiKey, baseUrl: body.baseUrl, extra: body.extra ?? {} });
      return { models };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/llm-configs/:id/test", async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = await ctx.llmConfigStore.getWithSecret(id);
    if (!config) return reply.code(404).send({ error: `Unknown LLM config: ${id}` });
    try {
      const result = await testLlmConfig(config.provider, { apiKey: config.apiKey, baseUrl: config.baseUrl ?? undefined, extra: config.extra });
      return { status: "success", ...result };
    } catch (error) {
      return reply.code(502).send({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  });
}
