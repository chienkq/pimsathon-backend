import crypto from "node:crypto";
import { llmConfigs, type WorkflowDb } from "@chienkq/workflow-db";
import type { LlmConfigKind, LlmConfigSummary, LlmProviderId } from "@chienkq/workflow-core";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../lib/credentialCrypto.js";

export interface LlmConfigInput {
  name: string;
  kind: LlmConfigKind;
  provider: LlmProviderId;
  model: string;
  /** Omitted = leave the stored key as-is (update only); empty string clears it. */
  apiKey?: string;
  baseUrl?: string;
  extra?: Record<string, string>;
  temperature: number;
  maxTokens: number;
  topP?: number;
  timeoutMs: number;
  systemPrompt?: string;
  /** Required for `kind: "embedding"`, ignored for `kind: "chat"`. */
  dimension?: number;
}

function toSummary(row: typeof llmConfigs.$inferSelect): LlmConfigSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as LlmConfigKind,
    provider: row.provider as LlmProviderId,
    model: row.model,
    baseUrl: row.baseUrl,
    extra: row.extra,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    topP: row.topP,
    timeoutMs: row.timeoutMs,
    systemPrompt: row.systemPrompt,
    dimension: row.dimension,
    isDefault: row.isDefault,
    hasApiKey: Boolean(row.apiKeyEncrypted),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * CRUD over the `llm_configs` table for the LLM Settings screen (Automation sidebar) — several named
 * rows (unlike `credentialStore`'s one-row-per-provider), since the whole point is letting different
 * workflow nodes point at different models/providers. API keys are AES-256-GCM encrypted at rest and
 * never returned to a caller outside the backend process; `list`/`get` only report `hasApiKey`.
 */
export function createLlmConfigStore(db: WorkflowDb) {
  async function get(id: string): Promise<LlmConfigSummary | undefined> {
    const [row] = await db.select().from(llmConfigs).where(eq(llmConfigs.id, id));
    return row ? toSummary(row) : undefined;
  }

  return {
    /** `kind` optionally narrows to just "chat" or "embedding" rows — used by Code Search's config
     *  picker, which should only ever list embedding configs. */
    async list(kind?: LlmConfigKind): Promise<LlmConfigSummary[]> {
      const rows = kind
        ? await db.select().from(llmConfigs).where(eq(llmConfigs.kind, kind)).orderBy(llmConfigs.createdAt)
        : await db.select().from(llmConfigs).orderBy(llmConfigs.createdAt);
      return rows.map(toSummary);
    },

    get,

    /** Internal use only (Test connection, node execution) — includes the decrypted API key. */
    async getWithSecret(id: string): Promise<(LlmConfigSummary & { apiKey?: string }) | undefined> {
      const [row] = await db.select().from(llmConfigs).where(eq(llmConfigs.id, id));
      if (!row) return undefined;
      return { ...toSummary(row), apiKey: row.apiKeyEncrypted ? decryptSecret(row.apiKeyEncrypted) : undefined };
    },

    async create(input: LlmConfigInput): Promise<LlmConfigSummary> {
      const id = crypto.randomUUID();
      const existing = await db.select({ id: llmConfigs.id }).from(llmConfigs).where(eq(llmConfigs.kind, input.kind)).limit(1);
      const isFirstOfKind = existing.length === 0;
      await db.insert(llmConfigs).values({
        id,
        name: input.name,
        kind: input.kind,
        provider: input.provider,
        model: input.model,
        apiKeyEncrypted: input.apiKey ? encryptSecret(input.apiKey) : null,
        baseUrl: input.baseUrl || null,
        extra: input.extra ?? {},
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        topP: input.topP ?? null,
        timeoutMs: input.timeoutMs,
        systemPrompt: input.systemPrompt || null,
        dimension: input.kind === "embedding" ? (input.dimension ?? null) : null,
        isDefault: isFirstOfKind,
      });
      return (await get(id))!;
    },

    async update(id: string, input: LlmConfigInput): Promise<LlmConfigSummary | undefined> {
      const set: Partial<typeof llmConfigs.$inferInsert> = {
        name: input.name,
        kind: input.kind,
        provider: input.provider,
        model: input.model,
        baseUrl: input.baseUrl || null,
        extra: input.extra ?? {},
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        topP: input.topP ?? null,
        timeoutMs: input.timeoutMs,
        systemPrompt: input.systemPrompt || null,
        dimension: input.kind === "embedding" ? (input.dimension ?? null) : null,
        updatedAt: new Date(),
      };
      if (input.apiKey !== undefined) set.apiKeyEncrypted = input.apiKey ? encryptSecret(input.apiKey) : null;
      await db.update(llmConfigs).set(set).where(eq(llmConfigs.id, id));
      return get(id);
    },

    async remove(id: string): Promise<void> {
      await db.delete(llmConfigs).where(eq(llmConfigs.id, id));
    },

    /** Unsets `isDefault` only within the target row's own `kind` — "chat" and "embedding" each keep
     *  their own independent default, since they're picked from independently (a node picking a
     *  default chat config vs. Code Search picking a default embedding config). */
    async setDefault(id: string): Promise<LlmConfigSummary | undefined> {
      const target = await get(id);
      if (!target) return undefined;
      await db.transaction(async (tx) => {
        await tx.update(llmConfigs).set({ isDefault: false }).where(eq(llmConfigs.kind, target.kind));
        await tx.update(llmConfigs).set({ isDefault: true }).where(eq(llmConfigs.id, id));
      });
      return get(id);
    },
  };
}

export type LlmConfigStore = ReturnType<typeof createLlmConfigStore>;
