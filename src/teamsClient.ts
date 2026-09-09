export interface TeamsClientService {
  sendMessage(text: string): Promise<void>;
  testConnection(): Promise<{ ok: boolean }>;
}

/** Real Microsoft Teams incoming-webhook client, used by the Integrations screen's "Test connection". */
export function createTeamsClient(config: { webhookUrl: string }): TeamsClientService {
  async function post(text: string): Promise<void> {
    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(`Teams webhook failed: ${response.status} ${response.statusText}`);
  }

  return {
    sendMessage: post,
    async testConnection() {
      await post("✅ PiM integration test — this Teams channel is connected.");
      return { ok: true };
    },
  };
}
