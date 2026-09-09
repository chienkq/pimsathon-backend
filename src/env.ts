import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jiraBaseUrl: process.env.JIRA_BASE_URL ?? "",
  jiraEmail: process.env.JIRA_EMAIL ?? "",
  jiraApiToken: process.env.JIRA_API_TOKEN ?? "",
  jiraJqlQuery: process.env.JIRA_JQL_QUERY ?? "updated >= -20m ORDER BY updated ASC",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  githubOwner: process.env.GITHUB_OWNER ?? "",
  githubRepo: process.env.GITHUB_REPO ?? "",
  // AES-256-GCM key (64 hex chars) used to encrypt rows in the `credentials` table (Integrations
  // screen, W6). Falls back to an insecure dev-only key so local dev doesn't need extra setup —
  // ALWAYS set a real one via `openssl rand -hex 32` before this backend is exposed beyond localhost.
  credentialsEncryptionKey: process.env.CREDENTIALS_ENCRYPTION_KEY ?? "0".repeat(64),
};

if (!process.env.CREDENTIALS_ENCRYPTION_KEY) {
  console.warn(
    "[env] CREDENTIALS_ENCRYPTION_KEY not set — using an insecure dev-only key. Stored integration credentials are NOT safe in this mode.",
  );
}
