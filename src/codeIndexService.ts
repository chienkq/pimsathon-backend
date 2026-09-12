import { EMBEDDING_VECTOR_DIMENSIONS } from "@chienkq/workflow-db";
import type { CodeIndexService, CodeSearchResult } from "@chienkq/workflow-core";
import { chunkFile } from "./codeChunker.js";
import type { CodeIndexStore, EmbeddedCodeChunk } from "./codeIndexStore.js";
import type { CodeSearchSettingsStore } from "./codeSearchSettingsStore.js";
import { createEmbeddingClient, type EmbeddingClient } from "./embeddingClient.js";
import type { LlmConfigStore } from "./llmConfigStore.js";
import type { LocalGitClient } from "./localGitClient.js";

/** Whole indexing budget for one reindex — matches `listProjectFiles`'s own per-call cap, kept
 *  generous since only TS/JS files actually get chunked (everything else is read then discarded). */
const REINDEX_MAX_TOTAL_BYTES = 8_000_000;

/**
 * Wires the Code Search pipeline together: Local Git (source) → tree-sitter chunker → an embedding
 * model chosen from LLM Settings (a `kind: "embedding"` `llm_configs` row) → pgvector store. Reads
 * the chosen config fresh on every call (same pattern as the other `createXFromCredentials`
 * factories) so a Settings change takes effect without a restart.
 */
export function createCodeIndexService(deps: {
  localGitClient: LocalGitClient;
  codeSearchSettingsStore: CodeSearchSettingsStore;
  codeIndexStore: CodeIndexStore;
  llmConfigStore: LlmConfigStore;
}): CodeIndexService {
  async function resolveEmbeddingClient(): Promise<EmbeddingClient> {
    const settings = await deps.codeSearchSettingsStore.get();
    if (!settings.embeddingConfigId) {
      throw new Error(
        "No embedding model chosen for Code Search yet. Pick one in Settings → Code Search (add an \"embedding\" LLM Config first if none exist).",
      );
    }
    const config = await deps.llmConfigStore.getWithSecret(settings.embeddingConfigId);
    if (!config) throw new Error("The LLM Config chosen for Code Search no longer exists — pick another in Settings → Code Search.");
    if (config.kind !== "embedding") throw new Error(`LLM Config "${config.name}" is a chat config, not an embedding config.`);
    if (config.dimension !== EMBEDDING_VECTOR_DIMENSIONS) {
      throw new Error(
        `LLM Config "${config.name}" produces ${config.dimension ?? "an unknown number of"}-dimensional vectors, but the code index column is fixed at ${EMBEDDING_VECTOR_DIMENSIONS} — pick a config with dimension ${EMBEDDING_VECTOR_DIMENSIONS}, or a schema migration is needed to change the column.`,
      );
    }
    return createEmbeddingClient({
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? undefined,
      extra: config.extra,
      model: config.model,
      timeoutMs: config.timeoutMs,
    });
  }

  return {
    async reindex(): Promise<{ filesScanned: number; chunksIndexed: number }> {
      const embeddingClient = await resolveEmbeddingClient();

      const { files } = await deps.localGitClient.listProjectFiles({ maxTotalBytes: REINDEX_MAX_TOTAL_BYTES });

      const chunks: Array<Omit<EmbeddedCodeChunk, "embedding">> = [];
      let filesScanned = 0;
      for (const file of files) {
        const fileChunks = await chunkFile(file.path, file.content);
        if (fileChunks.length === 0) continue;
        filesScanned += 1;
        chunks.push(...fileChunks);
      }

      if (chunks.length === 0) {
        await deps.codeIndexStore.replaceAll([]);
        return { filesScanned, chunksIndexed: 0 };
      }

      const embeddings = await embeddingClient.embedBatch(chunks.map((chunk) => chunk.content), "passage");
      const embedded: EmbeddedCodeChunk[] = chunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] }));
      await deps.codeIndexStore.replaceAll(embedded);

      return { filesScanned, chunksIndexed: embedded.length };
    },

    async search(query: string, topK: number): Promise<CodeSearchResult[]> {
      const embeddingClient = await resolveEmbeddingClient();
      const queryEmbedding = await embeddingClient.embed(query, "query");
      return deps.codeIndexStore.search(queryEmbedding, topK);
    },
  };
}
