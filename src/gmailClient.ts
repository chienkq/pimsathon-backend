export interface GmailClientService {
  sendMail(to: string, subject: string, body: string): Promise<void>;
  testConnection(): Promise<{ ok: boolean; detail?: string }>;
}

interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fromEmail: string;
}

interface TokenResponse {
  access_token?: string;
  error_description?: string;
  error?: string;
}

async function getAccessToken(config: GmailConfig): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await response.json()) as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(`Gmail token refresh failed: ${data.error_description ?? data.error ?? response.statusText}`);
  }
  return data.access_token;
}

function buildRawMessage(from: string, to: string, subject: string, body: string): string {
  const message = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join(
    "\r\n",
  );
  return Buffer.from(message).toString("base64url");
}

/** Real Gmail API (OAuth2 refresh token) client, used by the Integrations screen's "Test connection". */
export function createGmailClient(config: GmailConfig): GmailClientService {
  return {
    async sendMail(to, subject, body) {
      const token = await getAccessToken(config);
      const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: buildRawMessage(config.fromEmail, to, subject, body) }),
      });
      if (!response.ok) throw new Error(`Gmail send failed: ${response.status} ${response.statusText}`);
    },
    async testConnection() {
      const token = await getAccessToken(config);
      const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`Gmail profile check failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { emailAddress?: string };
      return { ok: true, detail: data.emailAddress };
    },
  };
}
