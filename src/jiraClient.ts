import type { JiraClientService, JiraIssue } from "@chienkq/workflow-core";

interface JiraSearchResponse {
  issues: { id: string; key: string; fields: Record<string, unknown> }[];
}

/** Real Jira Cloud REST API v3 client — the `services.jiraClient` implementation for the `jira` node. */
export function createJiraClient(config: { baseUrl: string; email: string; apiToken: string }): JiraClientService {
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");

  return {
    async searchIssues(jql, maxResults) {
      const response = await fetch(`${config.baseUrl}/rest/api/3/search`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ jql, maxResults, fields: ["summary", "status", "priority", "assignee", "project"] }),
      });
      if (!response.ok) {
        throw new Error(`Jira search failed: ${response.status} ${response.statusText} — ${await response.text()}`);
      }
      const data = (await response.json()) as JiraSearchResponse;
      const issues: JiraIssue[] = data.issues.map((issue) => ({ id: issue.id, key: issue.key, fields: issue.fields }));
      return issues;
    },
  };
}
