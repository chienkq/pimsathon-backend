import crypto from "node:crypto";
import { agentTools, type WorkflowDb } from "@chienkq/workflow-db";
import { eq } from "drizzle-orm";

const DEFAULT_PARAMETERS_SCHEMA = { type: "object", properties: {} };
const DEFAULT_CODE = "// `params` holds the arguments the model supplied, matching Parameters Schema.\nreturn {};";

export interface AgentToolInput {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  code: string;
}

export interface AgentToolSummary {
  id: string;
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  code: string;
  createdAt: string;
  updatedAt: string;
}

function toSummary(row: typeof agentTools.$inferSelect): AgentToolSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    parametersSchema: row.parametersSchema,
    code: row.code,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * CRUD over the `agent_tools` table for the "Tools" screen (Automation sidebar). Each row is a named
 * JS function (same "paste JavaScript" model as the `code` node) an AI Agent can call mid-conversation
 * — see `agentToolRunner.ts` for how `code` actually executes, and `llmClient.ts`'s `createAgentClient`
 * for how a tool's `name`/`description`/`parametersSchema` are sent to the provider.
 */
export function createAgentToolStore(db: WorkflowDb) {
  async function get(id: string): Promise<AgentToolSummary | undefined> {
    const [row] = await db.select().from(agentTools).where(eq(agentTools.id, id));
    return row ? toSummary(row) : undefined;
  }

  return {
    async list(): Promise<AgentToolSummary[]> {
      const rows = await db.select().from(agentTools).orderBy(agentTools.createdAt);
      return rows.map(toSummary);
    },

    get,

    async create(input: AgentToolInput): Promise<AgentToolSummary> {
      const id = crypto.randomUUID();
      await db.insert(agentTools).values({
        id,
        name: input.name,
        description: input.description,
        parametersSchema: input.parametersSchema ?? DEFAULT_PARAMETERS_SCHEMA,
        code: input.code || DEFAULT_CODE,
      });
      return (await get(id))!;
    },

    async update(id: string, input: AgentToolInput): Promise<AgentToolSummary | undefined> {
      await db
        .update(agentTools)
        .set({
          name: input.name,
          description: input.description,
          parametersSchema: input.parametersSchema ?? DEFAULT_PARAMETERS_SCHEMA,
          code: input.code || DEFAULT_CODE,
          updatedAt: new Date(),
        })
        .where(eq(agentTools.id, id));
      return get(id);
    },

    async remove(id: string): Promise<void> {
      await db.delete(agentTools).where(eq(agentTools.id, id));
    },
  };
}

export type AgentToolStore = ReturnType<typeof createAgentToolStore>;
