import type { LlmProviderId } from "@chienkq/workflow-core";

export interface LlmTestResult {
  ok: boolean;
  detail?: string;
}

/**
 * "Test connection" for the LLM Settings screen — a cheap, read-only call per provider (list models,
 * or an equivalent auth check) rather than spending tokens on a real completion. Mirrors the shape of
 * `testIntegration` in `index.ts`, kept separate since it only ever needs an `LlmConfig`'s fields, no
 * `credentialStore`.
 */
export async function testLlmConfig(
  provider: LlmProviderId,
  config: { apiKey?: string; baseUrl?: string; extra: Record<string, string> },
): Promise<LlmTestResult> {
  switch (provider) {
    case "openai": {
      const base = config.baseUrl || "https://api.openai.com/v1";
      const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
      const response = await fetch(`${base}/models`, { headers });
      if (!response.ok) throw new Error(`OpenAI auth check failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { data?: unknown[] };
      return { ok: true, detail: `${data.data?.length ?? 0} models visible to this key` };
    }
    case "anthropic": {
      const base = config.baseUrl || "https://api.anthropic.com";
      const response = await fetch(`${base}/v1/models`, {
        headers: { "x-api-key": config.apiKey ?? "", "anthropic-version": "2023-06-01" },
      });
      if (!response.ok) throw new Error(`Anthropic auth check failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { data?: unknown[] };
      return { ok: true, detail: `${data.data?.length ?? 0} models visible to this key` };
    }
    case "azure-openai": {
      const apiVersion = config.extra.apiVersion || "2024-08-01-preview";
      const response = await fetch(`${config.baseUrl}/openai/models?api-version=${apiVersion}`, {
        headers: { "api-key": config.apiKey ?? "" },
      });
      if (!response.ok) throw new Error(`Azure OpenAI auth check failed: ${response.status} ${response.statusText}`);
      return { ok: true, detail: "Resource reachable" };
    }
    case "google": {
      const base = config.baseUrl || "https://generativelanguage.googleapis.com";
      const response = await fetch(`${base}/v1beta/models?key=${encodeURIComponent(config.apiKey ?? "")}`);
      if (!response.ok) throw new Error(`Google auth check failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { models?: unknown[] };
      return { ok: true, detail: `${data.models?.length ?? 0} models visible to this key` };
    }
    case "ollama": {
      const response = await fetch(`${config.baseUrl}/api/tags`);
      if (!response.ok) throw new Error(`Ollama server check failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { models?: unknown[] };
      return { ok: true, detail: `${data.models?.length ?? 0} models pulled locally` };
    }
    case "openai-compatible": {
      const headers: Record<string, string> = {};
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      const response = await fetch(`${config.baseUrl}/models`, { headers });
      if (!response.ok) throw new Error(`Endpoint check failed: ${response.status} ${response.statusText}`);
      return { ok: true, detail: "Endpoint reachable" };
    }
  }
}

/**
 * Backs the Model field's dropdown on the LLM Settings form — calls the provider's own "list models"
 * endpoint with whatever connection fields are filled in so far (which may not be saved yet) and
 * returns just the model ids, newest/most-relevant first where the provider's response implies that.
 */
export async function listLlmModels(
  provider: LlmProviderId,
  config: { apiKey?: string; baseUrl?: string; extra: Record<string, string> },
): Promise<string[]> {
  switch (provider) {
    case "openai": {
      const base = config.baseUrl || "https://api.openai.com/v1";
      const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
      if (!response.ok) throw new Error(`OpenAI model list failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id).sort();
    }
    case "anthropic": {
      const base = config.baseUrl || "https://api.anthropic.com";
      const response = await fetch(`${base}/v1/models`, {
        headers: { "x-api-key": config.apiKey ?? "", "anthropic-version": "2023-06-01" },
      });
      if (!response.ok) throw new Error(`Anthropic model list failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id);
    }
    case "azure-openai": {
      const apiVersion = config.extra.apiVersion || "2024-08-01-preview";
      const response = await fetch(`${config.baseUrl}/openai/models?api-version=${apiVersion}`, {
        headers: { "api-key": config.apiKey ?? "" },
      });
      if (!response.ok) throw new Error(`Azure OpenAI model list failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id).sort();
    }
    case "google": {
      const base = config.baseUrl || "https://generativelanguage.googleapis.com";
      const response = await fetch(`${base}/v1beta/models?key=${encodeURIComponent(config.apiKey ?? "")}`);
      if (!response.ok) throw new Error(`Google model list failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { models?: { name: string }[] };
      return (data.models ?? []).map((m) => m.name.replace(/^models\//, ""));
    }
    case "ollama": {
      const response = await fetch(`${config.baseUrl}/api/tags`);
      if (!response.ok) throw new Error(`Ollama model list failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { models?: { name: string }[] };
      return (data.models ?? []).map((m) => m.name);
    }
    case "openai-compatible": {
      const headers: Record<string, string> = {};
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      const response = await fetch(`${config.baseUrl}/models`, { headers });
      if (!response.ok) throw new Error(`Model list failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id).sort();
    }
  }
}
