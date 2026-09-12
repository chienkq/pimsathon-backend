import crypto from "node:crypto";
import { aiAgents, type WorkflowDb } from "@chienkq/workflow-db";
import { eq } from "drizzle-orm";

export interface AiAgentInput {
  name: string;
  markdown: string;
  llmConfigId?: string;
  toolIds: string[];
  maxToolIterations: number;
}

export interface AiAgentSummary {
  id: string;
  name: string;
  markdown: string;
  llmConfigId: string | null;
  toolIds: string[];
  maxToolIterations: number;
  createdAt: string;
  updatedAt: string;
}

function toSummary(row: typeof aiAgents.$inferSelect): AiAgentSummary {
  return {
    id: row.id,
    name: row.name,
    markdown: row.markdown,
    llmConfigId: row.llmConfigId,
    toolIds: row.toolIds,
    maxToolIterations: row.maxToolIterations,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * CRUD over the `ai_agents` table for the "AI Agents" screen (Automation sidebar). An agent is just a
 * Markdown "system prompt" plus which `llm_configs` row to run on and which `agent_tools` rows it may
 * call — the "Send Message to Agent" node picks one of these by id (see `createAgentClient` in
 * `llmClient.ts` for how it's actually run).
 */
export function createAiAgentStore(db: WorkflowDb) {
  async function get(id: string): Promise<AiAgentSummary | undefined> {
    const [row] = await db.select().from(aiAgents).where(eq(aiAgents.id, id));
    return row ? toSummary(row) : undefined;
  }

  return {
    async list(): Promise<AiAgentSummary[]> {
      const rows = await db.select().from(aiAgents).orderBy(aiAgents.createdAt);
      return rows.map(toSummary);
    },

    get,

    async create(input: AiAgentInput): Promise<AiAgentSummary> {
      const id = crypto.randomUUID();
      await db.insert(aiAgents).values({
        id,
        name: input.name,
        markdown: input.markdown,
        llmConfigId: input.llmConfigId ?? null,
        toolIds: input.toolIds,
        maxToolIterations: input.maxToolIterations,
      });
      return (await get(id))!;
    },

    async update(id: string, input: AiAgentInput): Promise<AiAgentSummary | undefined> {
      await db
        .update(aiAgents)
        .set({
          name: input.name,
          markdown: input.markdown,
          llmConfigId: input.llmConfigId ?? null,
          toolIds: input.toolIds,
          maxToolIterations: input.maxToolIterations,
          updatedAt: new Date(),
        })
        .where(eq(aiAgents.id, id));
      return get(id);
    },

    async remove(id: string): Promise<void> {
      await db.delete(aiAgents).where(eq(aiAgents.id, id));
    },
  };
}

export type AiAgentStore = ReturnType<typeof createAiAgentStore>;
