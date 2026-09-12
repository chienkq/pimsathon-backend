import type { AgentToolStore } from "./agentToolStore.js";
import type { AiAgentStore } from "./aiAgentStore.js";

/**
 * Seeds the two `agent_tools` rows and the one `ai_agents` row the "Analyze Work Item Authenticity"
 * node (see `packages/workflow-core/src/nodeTypes/analyzeWorkItemAuthenticity.ts`) needs, so the
 * feature works out of the box instead of requiring the user to hand-build them in Settings → AI
 * Agents / Tools first. Idempotent (matched by name) — safe to call on every startup, and re-running
 * it after a manual edit in the UI leaves that edit alone (only creates what's missing).
 *
 * Each tool's JS `code` calls this backend's own `/api/local-git/*` routes rather than using
 * `localGitClient` directly — `runAgentTool` executes tool code in a bare `new AsyncFunction` with no
 * injected services (see `agentToolRunner.ts`), so an HTTP round-trip is the only way for a tool to
 * reach the local git checkout.
 */
export const AUTHENTICITY_SEARCH_CODE_TOOL_NAME = "search_code";
export const AUTHENTICITY_READ_FILE_TOOL_NAME = "read_file";
export const AUTHENTICITY_RECALL_WORKITEM_TOOL_NAME = "recall_workitem";
export const AUTHENTICITY_AGENT_NAME = "workitem-authenticity-analyst";

const AUTHENTICITY_AGENT_MARKDOWN = `
You verify whether a tracked work item has actually been implemented in this codebase, using only
local source code — no git history, no diffs, no semantic/embedding search, just plain-text/regex
search and file reads via your \`search_code\`/\`read_file\` tools, plus a \`recall_workitem\` tool
to pull a work item's full record (including its raw Jira payload) when you need more than the
context you were given.

You'll be given the work item's title/description/status as context. Whether you go straight to
source code or check the tracker first depends on what that context tells you:

- **If the context already includes a prior analysis (an "AI Note")** — a previous run's verdict plus
  the files it found relevant — trust that a source-code check is the right next step and go straight
  to it: re-read those files with \`read_file\` (or run a fresh \`search_code\` if they no longer look
  relevant) and confirm whether they still support that verdict.
- **If there is no AI Note yet**, do NOT search source code first. Call \`recall_workitem\` to fetch
  the work item's full record and its raw Jira payload (comments, changelog, custom fields — whatever
  \`jiraRaw\` carries), and read that first. Decide from it alone whether a source-code check is even
  necessary:
  - If the Jira raw content already makes the tracked status clear (e.g. it's explicitly still
    unstarted, or a comment/changelog entry already confirms or contradicts completion), you can reach
    your verdict directly from that — no need to touch \`search_code\`/\`read_file\` at all.
  - Only when the Jira content is ambiguous or silent on real completion should you then search the
    codebase: prefer a couple of targeted \`search_code\` calls before reading whole files, and stop
    calling tools as soon as you have enough evidence either way.

When you're done, respond with ONLY one JSON object (no prose, no markdown code fences):
{"verdict":"done"|"partial"|"not_found","confidence":<number 0-1>,"reasoning":"<short explanation>","relevantFiles":["<repo-relative path>", ...]}
"relevantFiles" should list only the source files that actually support your verdict — leave it empty
if your verdict came from the Jira raw content alone.
`.trim();

function backendBaseUrl(): string {
  return `http://localhost:${process.env.PORT ?? 4000}`;
}

const SEARCH_CODE_TOOL_CODE = `
const res = await fetch(\`${backendBaseUrl()}/api/local-git/search?pattern=\${encodeURIComponent(params.pattern)}\${params.maxResults ? \`&maxResults=\${params.maxResults}\` : ""}\`);
const body = await res.json();
if (!res.ok) throw new Error(body.error || "search_code failed");
return body.matches;
`.trim();

const READ_FILE_TOOL_CODE = `
const qs = new URLSearchParams({ path: params.path });
if (params.startLine) qs.set("start", String(params.startLine));
if (params.endLine) qs.set("end", String(params.endLine));
const res = await fetch(\`${backendBaseUrl()}/api/local-git/file?\${qs.toString()}\`);
const body = await res.json();
if (!res.ok) throw new Error(body.error || "read_file failed");
return body;
`.trim();

const RECALL_WORKITEM_TOOL_CODE = `
const res = await fetch(\`${backendBaseUrl()}/api/work-items/\${encodeURIComponent(params.workItemId)}\`);
const body = await res.json();
if (!res.ok) throw new Error(body.error || "recall_workitem failed");
return body.workItem;
`.trim();

/** Returns the (possibly pre-existing) AI Agent's id, so the caller can wire it into the seeded
 *  workflow's node parameters without hardcoding a random UUID. */
export async function seedAuthenticityAgent(aiAgentStore: AiAgentStore, agentToolStore: AgentToolStore): Promise<string> {
  const existingTools = await agentToolStore.list();
  const searchCodeTool =
    existingTools.find((t) => t.name === AUTHENTICITY_SEARCH_CODE_TOOL_NAME) ??
    (await agentToolStore.create({
      name: AUTHENTICITY_SEARCH_CODE_TOOL_NAME,
      description: "Searches the local git checkout for a keyword/regex pattern (like `git grep`) and returns matching file:line:text results.",
      parametersSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "git-grep basic-regex pattern, matched case-insensitively." },
          maxResults: { type: "number", description: "Max matches to return (default 20)." },
        },
        required: ["pattern"],
      },
      code: SEARCH_CODE_TOOL_CODE,
    }));

  const readFileTool =
    existingTools.find((t) => t.name === AUTHENTICITY_READ_FILE_TOOL_NAME) ??
    (await agentToolStore.create({
      name: AUTHENTICITY_READ_FILE_TOOL_NAME,
      description: "Reads a repo-relative file's content (optionally a line range) from the local git checkout.",
      parametersSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative file path." },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["path"],
      },
      code: READ_FILE_TOOL_CODE,
    }));

  const recallWorkItemTool =
    existingTools.find((t) => t.name === AUTHENTICITY_RECALL_WORKITEM_TOOL_NAME) ??
    (await agentToolStore.create({
      name: AUTHENTICITY_RECALL_WORKITEM_TOOL_NAME,
      description: "Fetches a work item's full record by id, including its raw Jira payload (jiraRaw) and any prior AI Note.",
      parametersSchema: {
        type: "object",
        properties: {
          workItemId: { type: "string", description: "The work item's id (not its display key)." },
        },
        required: ["workItemId"],
      },
      code: RECALL_WORKITEM_TOOL_CODE,
    }));

  const existingAgents = await aiAgentStore.list();
  const existing = existingAgents.find((a) => a.name === AUTHENTICITY_AGENT_NAME);
  if (existing) return existing.id;

  const created = await aiAgentStore.create({
    name: AUTHENTICITY_AGENT_NAME,
    markdown: AUTHENTICITY_AGENT_MARKDOWN,
    toolIds: [searchCodeTool.id, readFileTool.id, recallWorkItemTool.id],
    maxToolIterations: 8,
  });
  return created.id;
}
