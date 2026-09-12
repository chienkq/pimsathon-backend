/** Hard cap on how long one tool call may run before the agent loop gives up on it and reports a
 *  timeout error back to the model (which can then answer without it, or retry differently). */
const TOOL_TIMEOUT_MS = 30_000;

/**
 * Executes one `agent_tools` row's pasted JavaScript against the arguments an LLM tool call supplied.
 * Same "paste JavaScript, no sandbox" trust model as the `code` node's `new Function` (see
 * `packages/workflow-core/src/nodeTypes/code.ts`) — just run server-side here, since a tool call
 * happens inside the backend's own LLM request/response loop (`llmAgentRunner.ts`), not a workflow
 * node's `execute()`. `async`/`await`/`fetch` all work, unlike the Code node's synchronous `Function`.
 */
export async function runAgentTool(code: string, params: Record<string, unknown>): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (params: Record<string, unknown>) => Promise<unknown>;
  const run = new AsyncFunction("params", `"use strict";\n${code}`);

  let timeoutId: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Tool timed out after ${TOOL_TIMEOUT_MS / 1000}s.`)), TOOL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(params), timeout]);
  } finally {
    clearTimeout(timeoutId!);
  }
}
