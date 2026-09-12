import type { LlmProviderId } from "@chienkq/workflow-core";

export interface EmbeddingConfig {
  provider: LlmProviderId;
  apiKey?: string;
  baseUrl?: string;
  extra: Record<string, string>;
  model: string;
  timeoutMs: number;
}

export type EmbeddingRole = "query" | "passage";

function applyPrefix(config: EmbeddingConfig, role: EmbeddingRole, text: string): string {
  const prefix = role === "query" ? config.extra.queryPrefix : config.extra.passagePrefix;
  return prefix ? `${prefix}${text}` : text;
}

/** One request per text — the provider APIs below don't share a single batch shape, so batching
 *  (below) just runs several of these concurrently rather than building a provider-specific batch call. */
async function embedOne(config: EmbeddingConfig, role: EmbeddingRole, rawText: string): Promise<number[]> {
  const text = applyPrefix(config, role, rawText);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    switch (config.provider) {
      case "openai":
      case "openai-compatible": {
        const base = config.baseUrl || "https://api.openai.com/v1";
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
        const response = await fetch(`${base}/embeddings`, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({ model: config.model, input: text }),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`${config.provider} embeddings request failed (${response.status}): ${detail || response.statusText}`);
        }
        const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
        const embedding = data.data?.[0]?.embedding;
        if (!Array.isArray(embedding)) throw new Error(`${config.provider} embeddings response had no \`data[0].embedding\` array.`);
        return embedding;
      }
      case "azure-openai": {
        const apiVersion = config.extra.apiVersion || "2024-08-01-preview";
        const deployment = config.extra.deploymentName || config.model;
        const response = await fetch(`${config.baseUrl}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`, {
          method: "POST",
          headers: { "content-type": "application/json", "api-key": config.apiKey ?? "" },
          signal: controller.signal,
          body: JSON.stringify({ input: text }),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`Azure OpenAI embeddings request failed (${response.status}): ${detail || response.statusText}`);
        }
        const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
        const embedding = data.data?.[0]?.embedding;
        if (!Array.isArray(embedding)) throw new Error("Azure OpenAI embeddings response had no `data[0].embedding` array.");
        return embedding;
      }
      case "google": {
        const base = config.baseUrl || "https://generativelanguage.googleapis.com";
        const response = await fetch(
          `${base}/v1beta/models/${config.model}:embedContent?key=${encodeURIComponent(config.apiKey ?? "")}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({ content: { parts: [{ text }] } }),
          },
        );
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`Google embeddings request failed (${response.status}): ${detail || response.statusText}`);
        }
        const data = (await response.json()) as { embedding?: { values?: number[] } };
        if (!Array.isArray(data.embedding?.values)) throw new Error("Google embeddings response had no `embedding.values` array.");
        return data.embedding.values;
      }
      case "ollama": {
        const response = await fetch(new URL("/api/embeddings", config.baseUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ model: config.model, prompt: text }),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`Ollama embeddings request failed (${response.status}): ${detail || response.statusText}`);
        }
        const data = (await response.json()) as { embedding?: number[] };
        if (!Array.isArray(data.embedding)) throw new Error("Ollama embeddings response had no `embedding` array.");
        return data.embedding;
      }
      default:
        throw new Error(`Provider "${config.provider}" has no embeddings support.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function createEmbeddingClient(config: EmbeddingConfig) {
  return {
    embed: (text: string, role: EmbeddingRole) => embedOne(config, role, text),

    /** Concurrency-windowed rather than a real batch call — none of the provider APIs above share a
     *  single multi-input request shape worth building a batch path for here. */
    async embedBatch(texts: string[], role: EmbeddingRole, concurrency = 4): Promise<number[][]> {
      const results = new Array<number[]>(texts.length);
      let cursor = 0;
      async function worker() {
        while (cursor < texts.length) {
          const index = cursor++;
          results[index] = await embedOne(config, role, texts[index]);
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, () => worker()));
      return results;
    },
  };
}

export type EmbeddingClient = ReturnType<typeof createEmbeddingClient>;
