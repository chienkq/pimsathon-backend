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
};
