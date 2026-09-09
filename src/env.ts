import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jiraJqlQuery: process.env.JIRA_JQL_QUERY ?? "updated >= -20m ORDER BY updated ASC",
  // Jira (site URL/email/API token) and GitHub (token/owner/repo) are no longer env-configured — see
  // credentialStore.ts / jiraClient.ts's createJiraClientFromCredentials and githubClient.ts's
  // createGitClientFromCredentials, sourced from the Integrations screen (Settings) instead.
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
