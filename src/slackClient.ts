export interface SlackClientService {
  sendMessage(channel: string, text: string): Promise<{ ts: string }>;
  testConnection(): Promise<{ ok: boolean; team?: string }>;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  team?: string;
}

/** Real Slack Web API client, used by the Integrations screen's "Test connection". */
export function createSlackClient(config: { botToken: string }): SlackClientService {
  async function call(method: string, body: Record<string, unknown>): Promise<SlackApiResponse> {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.botToken}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as SlackApiResponse;
    if (!response.ok || !data.ok) throw new Error(`Slack API ${method} failed: ${data.error ?? response.statusText}`);
    return data;
  }

  return {
    async sendMessage(channel, text) {
      const data = await call("chat.postMessage", { channel, text });
      return { ts: data.ts ?? "" };
    },
    async testConnection() {
      const data = await call("auth.test", {});
      return { ok: data.ok, team: data.team };
    },
  };
}
