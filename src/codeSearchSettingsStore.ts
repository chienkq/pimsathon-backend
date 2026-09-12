import type { AppSettingsStore } from "./appSettingsStore.js";

export interface CodeSearchSettings extends Record<string, unknown> {
  /** Id of a `kind: "embedding"` row in `llm_configs` (LLM Settings screen), or null if none chosen
   *  yet. Code Search no longer keeps its own embedding baseUrl/model/key — it reuses a named LLM
   *  Config so credentials live in exactly one place. */
  embeddingConfigId: string | null;
}

const SETTINGS_ID = "code-search";

const DEFAULTS: CodeSearchSettings = {
  embeddingConfigId: null,
};

export function createCodeSearchSettingsStore(appSettingsStore: AppSettingsStore) {
  return {
    async get(): Promise<CodeSearchSettings> {
      const stored = await appSettingsStore.get<CodeSearchSettings>(SETTINGS_ID);
      return { ...DEFAULTS, ...stored };
    },

    async set(settings: CodeSearchSettings): Promise<void> {
      await appSettingsStore.set(SETTINGS_ID, settings);
    },
  };
}

export type CodeSearchSettingsStore = ReturnType<typeof createCodeSearchSettingsStore>;
