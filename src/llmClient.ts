import type { AiAgentLlmService } from "@chienkq/workflow-core";
import type { LlmConfigStore } from "./llmConfigStore.js";
import { completeChat } from "./llmComplete.js";

/** Cap on how much of an input item's JSON gets embedded as prompt context — a git "Read Project
 *  Files" item can carry hundreds of KB of file contents, well past what's useful (or affordable) to
 *  paste into a single chat message regardless of provider. */
const MAX_CONTEXT_CHARS = 60_000;

function buildContextText(context: unknown): string | undefined {
  if (context === undefined || context === null) return undefined;
  if (typeof context === "object" && Object.keys(context as object).length === 0) return undefined;
  const full = JSON.stringify(context, null, 2);
  if (full.length <= MAX_CONTEXT_CHARS) return full;
  return `${full.slice(0, MAX_CONTEXT_CHARS)}\n... [truncated, ${full.length - MAX_CONTEXT_CHARS} more characters omitted]`;
}

/**
 * Backs the "Send Message to AI Agent" node's real (non-stub) execution — resolves `agentName`
 * against a named row in `llm_configs` (the LLM Settings screen) and calls that provider for real,
 * via `completeChat`. Mirrors the `createXClientFromCredentials` pattern: re-reads the config store on
 * every call so a Settings change takes effect immediately, no restart needed.
 */
export function createLlmClient(llmConfigStore: LlmConfigStore): AiAgentLlmService {
  return {
    async complete(agentName, { message, context }) {
      const configs = await llmConfigStore.list();
      const match = configs.find((c) => c.name === agentName);
      if (!match) {
        throw new Error(
          `No LLM Config named "${agentName}" found. Configure one in Settings → LLM Settings, or point this node's Agent field at an existing config's name.`
        );
      }
      const full = await llmConfigStore.getWithSecret(match.id);
      if (!full) throw new Error(`LLM Config "${agentName}" could not be loaded.`);

      const contextText = buildContextText(context);
      const userContent = contextText ? `${message}\n\nContext:\n${contextText}` : message;

      const messages = [] as { role: "system" | "user"; content: string }[];
      if (full.systemPrompt) messages.push({ role: "system", content: full.systemPrompt });
      messages.push({ role: "user", content: userContent });

      return completeChat(
        full.provider,
        {
          apiKey: full.apiKey,
          baseUrl: full.baseUrl ?? undefined,
          extra: full.extra,
          model: full.model,
          temperature: full.temperature,
          maxTokens: full.maxTokens,
          topP: full.topP,
          timeoutMs: full.timeoutMs,
        },
        messages
      );
    },
  };
}
