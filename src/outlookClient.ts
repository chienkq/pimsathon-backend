export interface OutlookClientService {
  sendMail(to: string, subject: string, body: string): Promise<void>;
  testConnection(): Promise<{ ok: boolean }>;
}

interface OutlookConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  senderUpn: string;
}

interface TokenResponse {
  access_token?: string;
  error_description?: string;
}

async function getAccessToken(config: OutlookConfig): Promise<string> {
  const response = await fetch(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  const data = (await response.json()) as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(`Outlook token request failed: ${data.error_description ?? response.statusText}`);
  }
  return data.access_token;
}

/** Real Microsoft Graph (client-credentials) client, used by the Integrations screen's "Test connection". */
export function createOutlookClient(config: OutlookConfig): OutlookClientService {
  return {
    async sendMail(to, subject, body) {
      const token = await getAccessToken(config);
      const response = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.senderUpn)}/sendMail`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              subject,
              body: { contentType: "Text", content: body },
              toRecipients: [{ emailAddress: { address: to } }],
            },
          }),
        },
      );
      if (!response.ok) throw new Error(`Outlook sendMail failed: ${response.status} ${response.statusText}`);
    },
    async testConnection() {
      await getAccessToken(config);
      return { ok: true };
    },
  };
}
