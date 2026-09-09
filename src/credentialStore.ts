import type { IntegrationProviderId } from "@chienkq/workflow-core";
import { credentials, type WorkflowDb } from "@chienkq/workflow-db";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./credentialCrypto.js";

/**
 * CRUD over the `credentials` table for the Integrations screen (W6) — one row per provider
 * (`id` = provider id), config stored as an encrypted JSON blob. Never returns decrypted values
 * to a caller outside the backend process; API routes only ever expose which keys are set.
 */
export function createCredentialStore(db: WorkflowDb) {
  return {
    async getConfig(provider: IntegrationProviderId): Promise<Record<string, string> | undefined> {
      const [row] = await db.select().from(credentials).where(eq(credentials.id, provider));
      if (!row) return undefined;
      return JSON.parse(decryptSecret(row.secretEncrypted)) as Record<string, string>;
    },

    async setConfig(provider: IntegrationProviderId, config: Record<string, string>): Promise<void> {
      const secretEncrypted = encryptSecret(JSON.stringify(config));
      await db
        .insert(credentials)
        .values({ id: provider, provider, name: provider, secretEncrypted })
        .onConflictDoUpdate({ target: credentials.id, set: { secretEncrypted } });
    },

    async remove(provider: IntegrationProviderId): Promise<void> {
      await db.delete(credentials).where(eq(credentials.id, provider));
    },

    /** Which providers currently have a stored credential, keyed by provider id. */
    async listConfiguredProviders(): Promise<Set<string>> {
      const rows = await db.select({ id: credentials.id }).from(credentials);
      return new Set(rows.map((r) => r.id));
    },
  };
}

export type CredentialStore = ReturnType<typeof createCredentialStore>;
