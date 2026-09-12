import { appSettings, type WorkflowDb } from "@chienkq/workflow-db";
import { eq } from "drizzle-orm";

/** Tiny key/value store for workspace-wide settings that don't belong in the `credentials` table
 *  (nothing to encrypt, not tied to one integration provider) — e.g. Git Control's default source. */
export function createAppSettingsStore(db: WorkflowDb) {
  return {
    async get<T extends Record<string, unknown>>(id: string): Promise<T | undefined> {
      const [row] = await db.select().from(appSettings).where(eq(appSettings.id, id));
      return row?.value as T | undefined;
    },

    async set(id: string, value: Record<string, unknown>): Promise<void> {
      await db
        .insert(appSettings)
        .values({ id, value, updatedAt: new Date() })
        .onConflictDoUpdate({ target: appSettings.id, set: { value, updatedAt: new Date() } });
    },
  };
}

export type AppSettingsStore = ReturnType<typeof createAppSettingsStore>;
