import type { LlmProviderId } from "@chienkq/workflow-core";
import type { LlmCompleteConfig } from "./llmComplete.js";
import { completeChat } from "./llmComplete.js";

/** Default cap on how many tool-call round-trips one agent turn may take before it's treated as
 *  stuck — overridable per-agent via `RunAgentOptions.maxToolIterations` (see the AI Agent Edit
 *  screen's "Max tool calls" field, `ai_agents.max_tool_iterations`). */
const DEFAULT_MAX_TOOL_ITERATIONS = 8;

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema `object` describing the tool's arguments — sent to the provider as-is. */
  parameters: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** One tool-call round-trip: what the model said/asked for, and what each tool call returned. Built
 *  up as `runAgent` loops, so a stuck or slow-to-converge agent can be inspected step by step instead
 *  of only seeing its final answer (or, on hitting `maxToolIterations`, a bare error). */
export interface AgentRoundTrip {
  iteration: number;
  assistantContent: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolResults: Array<{ id: string; name: string; content: string; isError: boolean }>;
}

export interface AgentRunResult {
  content: string;
  trace: AgentRoundTrip[];
}

/** Thrown when the model doesn't produce a final answer within `maxToolIterations` — carries the
 *  full round-trip trace so the caller (the node's output, surfaced in the NDV) can show what the
 *  agent tried instead of just the bare "exceeded N round-trips" message. */
export class AgentRoundTripLimitError extends Error {
  trace: AgentRoundTrip[];
  constructor(message: string, trace: AgentRoundTrip[]) {
    super(message);
    this.name = "AgentRoundTripLimitError";
    this.trace = trace;
  }
}

export interface RunAgentOptions {
  provider: LlmProviderId;
  config: LlmCompleteConfig;
  /** The agent's Markdown content — sent as the system message. Empty string omits the system message. */
  systemPrompt: string;
  userMessage: string;
  tools: AgentTool[];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Overrides `DEFAULT_MAX_TOOL_ITERATIONS` — pass the agent's own `maxToolIterations`. */
  maxToolIterations?: number;
}

function safeParseJsonArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toolResultText(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result ?? null);
}

async function openAiStyleTurn(
  provider: "openai" | "openai-compatible" | "azure-openai",
  config: LlmCompleteConfig,
  messages: unknown[],
  tools: AgentTool[],
): Promise<{ content: string; toolCalls: AgentToolCall[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const body: Record<string, unknown> = {
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      top_p: config.topP ?? undefined,
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = "auto";
    }

    let url: string;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (provider === "azure-openai") {
      const apiVersion = config.extra.apiVersion || "2024-08-01-preview";
      const deployment = config.extra.deploymentName || config.model;
      url = `${config.baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
      headers["api-key"] = config.apiKey ?? "";
    } else {
      const base = config.baseUrl || "https://api.openai.com/v1";
      url = `${base}/chat/completions`;
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      body.model = config.model;
    }

    const response = await fetch(url, { method: "POST", headers, signal: controller.signal, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${provider} completion failed: ${response.status} ${response.statusText}`);
    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      }>;
    };
    const message = data.choices?.[0]?.message;
    return {
      content: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: safeParseJsonArgs(tc.function.arguments),
      })),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function anthropicTurn(
  config: LlmCompleteConfig,
  system: string | undefined,
  messages: unknown[],
  tools: AgentTool[],
): Promise<{ content: string; toolCalls: AgentToolCall[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const base = config.baseUrl || "https://api.anthropic.com";
    const body: Record<string, unknown> = {
      model: config.model,
      system,
      messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      top_p: config.topP ?? undefined,
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": config.apiKey ?? "", "anthropic-version": "2023-06-01" },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Anthropic completion failed: ${response.status} ${response.statusText}`);
    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    };
    const blocks = data.content ?? [];
    return {
      content: blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
      toolCalls: blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id ?? "", name: b.name ?? "", arguments: b.input ?? {} })),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Runs one AI Agent turn to completion: sends the system prompt + user message to its LLM Config,
 * and — for providers whose API supports it (OpenAI-style function calling, Anthropic tool use) —
 * lets the model call any of `tools` as many times as it needs (up to `maxToolIterations`) before
 * returning its final text answer. Google Gemini and Ollama have no tool-calling support wired up
 * here yet, so an agent assigned tools on one of those providers fails loudly instead of silently
 * ignoring them.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const { provider, config, systemPrompt, userMessage, tools, executeTool } = options;
  const maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;

  if (provider === "google" || provider === "ollama") {
    if (tools.length > 0) {
      const providerName = provider === "google" ? "Google Gemini" : "Ollama";
      throw new Error(
        `${providerName} doesn't support tool calling in this app yet — remove this agent's Tools, or point it at an OpenAI, Anthropic, Azure OpenAI, or OpenAI-compatible LLM Config instead.`,
      );
    }
    const content = await completeChat(provider, config, [
      ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
      { role: "user" as const, content: userMessage },
    ]);
    return { content, trace: [] };
  }

  if (provider === "anthropic") {
    const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [{ role: "user", content: userMessage }];
    const trace: AgentRoundTrip[] = [];
    for (let i = 0; i < maxToolIterations; i++) {
      const turn = await anthropicTurn(config, systemPrompt || undefined, messages, tools);
      if (turn.toolCalls.length === 0) return { content: turn.content, trace };

      messages.push({
        role: "assistant",
        content: [
          ...(turn.content ? [{ type: "text", text: turn.content }] : []),
          ...turn.toolCalls.map((tc) => ({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments })),
        ],
      });
      const toolResults = await Promise.all(
        turn.toolCalls.map(async (tc) => {
          try {
            const result = await executeTool(tc.name, tc.arguments);
            return { type: "tool_result", tool_use_id: tc.id, content: toolResultText(result), is_error: false };
          } catch (error) {
            return {
              type: "tool_result",
              tool_use_id: tc.id,
              content: `Error: ${error instanceof Error ? error.message : String(error)}`,
              is_error: true,
            };
          }
        }),
      );
      messages.push({ role: "user", content: toolResults.map(({ type, tool_use_id, content, is_error }) => (is_error ? { type, tool_use_id, content, is_error } : { type, tool_use_id, content })) });
      trace.push({
        iteration: i + 1,
        assistantContent: turn.content,
        toolCalls: turn.toolCalls,
        toolResults: toolResults.map((tr) => ({ id: tr.tool_use_id, name: turn.toolCalls.find((tc) => tc.id === tr.tool_use_id)?.name ?? "", content: tr.content, isError: tr.is_error })),
      });
    }
    throw new AgentRoundTripLimitError(`Agent exceeded ${maxToolIterations} tool-call round-trips without a final answer.`, trace);
  }

  // openai / openai-compatible / azure-openai
  const messages: unknown[] = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    { role: "user", content: userMessage },
  ];
  const trace: AgentRoundTrip[] = [];
  for (let i = 0; i < maxToolIterations; i++) {
    const turn = await openAiStyleTurn(provider, config, messages, tools);
    if (turn.toolCalls.length === 0) return { content: turn.content, trace };

    messages.push({
      role: "assistant",
      content: turn.content || null,
      tool_calls: turn.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })),
    });
    const toolResults: Array<{ id: string; name: string; content: string; isError: boolean }> = [];
    for (const tc of turn.toolCalls) {
      let content: string;
      let isError = false;
      try {
        // eslint-disable-next-line no-await-in-loop -- tool calls in one turn run sequentially so each result is available before the next; OpenAI's message format doesn't need them parallel
        content = toolResultText(await executeTool(tc.name, tc.arguments));
      } catch (error) {
        content = `Error: ${error instanceof Error ? error.message : String(error)}`;
        isError = true;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content });
      toolResults.push({ id: tc.id, name: tc.name, content, isError });
    }
    trace.push({ iteration: i + 1, assistantContent: turn.content, toolCalls: turn.toolCalls, toolResults });
  }
  throw new AgentRoundTripLimitError(`Agent exceeded ${maxToolIterations} tool-call round-trips without a final answer.`, trace);
}
