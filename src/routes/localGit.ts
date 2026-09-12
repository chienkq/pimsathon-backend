import { GIT_CONTROL_PROVIDER_IDS, type GitControlDefaultSource, type IntegrationProviderId } from "@chienkq/workflow-core";
import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";
import type { CodeSearchSettings } from "../store/codeSearchSettingsStore.js";

const GIT_CONTROL_SETTINGS_ID = "git-control";

export function registerLocalGitRoutes(app: FastifyInstance, ctx: BackendContext) {
  // Reads a code snippet from the `local-git` integration's configured folder — used by the Work Item
  // AI Note "Insert code reference" action to test code-location memos without a real GitHub connection.
  app.get("/api/local-git/file", async (request, reply) => {
    const { path: filePath, start, end } = request.query as { path?: string; start?: string; end?: string };
    if (!filePath) return reply.code(400).send({ error: "Query param `path` is required." });
    try {
      const snippet = await ctx.services.localGitClient.getFileSnippet(
        filePath,
        start ? Number(start) : undefined,
        end ? Number(end) : undefined,
      );
      return snippet;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
  });

  // `git grep` over the `local-git` folder — exposed as an HTTP route (not just the in-process
  // `localGitClient` service) so an `agent_tools` row's sandboxed JS (no service injection, see
  // `services/agents/agentToolRunner.ts`) can call it as a real function-calling tool, e.g. for the "Analyze Work Item
  // Authenticity" AI Agent's `search_code` tool.
  app.get("/api/local-git/search", async (request, reply) => {
    const { pattern, maxResults, ignoreCase } = request.query as { pattern?: string; maxResults?: string; ignoreCase?: string };
    if (!pattern) return reply.code(400).send({ error: "Query param `pattern` is required." });
    try {
      const matches = await ctx.services.localGitClient.searchCode(pattern, {
        maxResults: maxResults ? Number(maxResults) : undefined,
        ignoreCase: ignoreCase === undefined ? undefined : ignoreCase !== "false",
      });
      return { matches };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Local branch names matching a work item key (e.g. "PROJ-12"), for the work item Development tab
  // when Local Git is the chosen source — the local-git equivalent of GitHub's "Branches" section.
  app.get("/api/local-git/branches", async (request, reply) => {
    const { q } = request.query as { q?: string };
    try {
      return { branches: await ctx.services.localGitClient.listBranches(q) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Git Control — which git backend (GitHub or Local Git) the work item Development tab shows by
  // default. A workspace-wide preference, not a per-provider credential, so it lives in the small
  // `app_settings` table rather than `credentials`.
  app.get("/api/settings/git-control", async () => {
    const stored = await ctx.appSettingsStore.get<{ defaultSource?: GitControlDefaultSource }>(GIT_CONTROL_SETTINGS_ID);
    return { defaultSource: stored?.defaultSource ?? "github" };
  });

  app.put("/api/settings/git-control", async (request, reply) => {
    const { defaultSource } = (request.body as { defaultSource?: string } | undefined) ?? {};
    if (!defaultSource || !GIT_CONTROL_PROVIDER_IDS.includes(defaultSource as IntegrationProviderId))
      return reply.code(400).send({ error: `\`defaultSource\` must be one of: ${GIT_CONTROL_PROVIDER_IDS.join(", ")}` });
    await ctx.appSettingsStore.set(GIT_CONTROL_SETTINGS_ID, { defaultSource });
    return { status: "success", defaultSource };
  });

  // Code Search — which `llm_configs` row (kind: "embedding") to embed with, plus manual
  // reindex/search actions, surfaced from a Project Settings section. Indexing always reads from
  // the same `local-git` repo used elsewhere (see `services.localGitClient` above) — no separate repo picker.
  // The embedding model/credentials themselves live in LLM Settings (Automation sidebar), not here.
  app.get("/api/settings/code-search", async () => {
    return ctx.codeSearchSettingsStore.get();
  });

  app.put("/api/settings/code-search", async (request, reply) => {
    const { embeddingConfigId } = (request.body as Partial<CodeSearchSettings> | undefined) ?? {};
    if (embeddingConfigId) {
      const config = await ctx.llmConfigStore.get(embeddingConfigId);
      if (!config) return reply.code(400).send({ error: `Unknown LLM config: ${embeddingConfigId}` });
      if (config.kind !== "embedding") return reply.code(400).send({ error: `LLM Config "${config.name}" is not an embedding config.` });
    }
    const settings: CodeSearchSettings = { embeddingConfigId: embeddingConfigId ?? null };
    await ctx.codeSearchSettingsStore.set(settings);
    return { status: "success", ...settings };
  });

  app.get("/api/code-index/count", async () => {
    return { count: await ctx.codeIndexStore.count() };
  });

  app.post("/api/code-index/reindex", async (_request, reply) => {
    try {
      return await ctx.services.codeIndex.reindex();
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/code-index/search", async (request, reply) => {
    const { query, topK } = (request.body as { query?: string; topK?: number } | undefined) ?? {};
    if (!query?.trim()) return reply.code(400).send({ error: "`query` is required." });
    try {
      return { results: await ctx.services.codeIndex.search(query.trim(), Math.min(Math.max(topK ?? 5, 1), 50)) };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
