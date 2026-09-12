import type { LlmProviderId } from "@chienkq/workflow-core";

export interface LlmChatMessage {
  role: "system" | "user";
  content: string;
}

export interface LlmCompleteConfig {
  apiKey?: string;
  baseUrl?: string;
  extra: Record<string, string>;
  model: string;
  temperature: number;
  maxTokens: number;
  topP?: number | null;
  timeoutMs: number;
}

/**
 * Real chat-completion call per provider — the counterpart to `llmProviderTest.ts`'s cheap
 * "list models" auth check, actually spends tokens and returns the model's text. Used by
 * `llmClient.ts` to back the "Send Message to AI Agent" node's real (non-stub) execution.
 */
export async function completeChat(provider: LlmProviderId, config: LlmCompleteConfig, messages: LlmChatMessage[]): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    switch (provider) {
      case "openai":
      case "openai-compatible": {
        const base = config.baseUrl || "https://api.openai.com/v1";
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
        const response = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            messages,
            temperature: config.temperature,
            max_tokens: config.maxTokens,
            top_p: config.topP ?? undefined,
          }),
        });
        if (!response.ok) throw new Error(`${provider} completion failed: ${response.status} ${response.statusText}`);
        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content ?? "";
      }
      case "anthropic": {
        const base = config.baseUrl || "https://api.anthropic.com";
        const system = messages.find((m) => m.role === "system")?.content;
        const userMessages = messages.filter((m) => m.role === "user").map((m) => ({ role: "user" as const, content: m.content }));
        const response = await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": config.apiKey ?? "",
            "anthropic-version": "2023-06-01",
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            system,
            messages: userMessages,
            max_tokens: config.maxTokens,
            temperature: config.temperature,
            top_p: config.topP ?? undefined,
          }),
        });
        if (!response.ok) throw new Error(`Anthropic completion failed: ${response.status} ${response.statusText}`);
        const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
        return (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      }
      case "azure-openai": {
        const apiVersion = config.extra.apiVersion || "2024-08-01-preview";
        const deployment = config.extra.deploymentName || config.model;
        const response = await fetch(`${config.baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`, {
          method: "POST",
          headers: { "content-type": "application/json", "api-key": config.apiKey ?? "" },
          signal: controller.signal,
          body: JSON.stringify({
            messages,
            temperature: config.temperature,
            max_tokens: config.maxTokens,
            top_p: config.topP ?? undefined,
          }),
        });
        if (!response.ok) throw new Error(`Azure OpenAI completion failed: ${response.status} ${response.statusText}`);
        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content ?? "";
      }
      case "google": {
        const base = config.baseUrl || "https://generativelanguage.googleapis.com";
        const system = messages.find((m) => m.role === "system")?.content;
        const contents = messages
          .filter((m) => m.role === "user")
          .map((m) => ({ role: "user", parts: [{ text: m.content }] }));
        const response = await fetch(`${base}/v1beta/models/${config.model}:generateContent?key=${encodeURIComponent(config.apiKey ?? "")}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            contents,
            systemInstruction: system ? { parts: [{ text: system }] } : undefined,
            generationConfig: {
              temperature: config.temperature,
              maxOutputTokens: config.maxTokens,
              topP: config.topP ?? undefined,
            },
          }),
        });
        if (!response.ok) throw new Error(`Google completion failed: ${response.status} ${response.statusText}`);
        const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      }
      case "ollama": {
        const response = await fetch(`${config.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            messages,
            stream: false,
            options: { temperature: config.temperature, top_p: config.topP ?? undefined },
          }),
        });
        if (!response.ok) throw new Error(`Ollama completion failed: ${response.status} ${response.statusText}`);
        const data = (await response.json()) as { message?: { content?: string } };
        return data.message?.content ?? "";
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}
