import type { JiraClientService, JiraIssue } from "@chienkq/workflow-core";
import type { CredentialStore } from "../../store/credentialStore.js";

interface JiraSearchResponseIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
  renderedFields?: Record<string, unknown>;
  changelog?: Record<string, unknown>;
}

interface JiraSearchResponse {
  issues: JiraSearchResponseIssue[];
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
        body: JSON.stringify({
          jql,
          maxResults,
          // `["*all"]` so every field Jira exposes for this issue (description, comment, attachment,
          // worklog, custom fields, etc.) is captured — not just the handful this node's own UI reads —
          // so the full raw issue can be persisted as-is on the work item (see ticketUpsert.ts's `raw`).
          // Note: Jira's `comment`/`worklog`/`attachment` fields on the search endpoint are themselves
          // paginated by Jira (only the most recent page), not the complete history — a known REST API
          // limitation, not something this client can widen further without per-issue follow-up calls.
          fields: ["*all"],
          expand: ["changelog", "renderedFields"],
        }),
      });
      if (!response.ok) {
        throw new Error(`Jira search failed: ${response.status} ${response.statusText} — ${await response.text()}`);
      }
      const data = (await response.json()) as JiraSearchResponse;
      const issues: JiraIssue[] = data.issues.map((issue) => ({
        id: issue.id,
        key: issue.key,
        fields: issue.fields,
        renderedFields: issue.renderedFields,
        changelog: issue.changelog,
      }));
      return issues;
    },
  };
}

/**
 * `services.jiraClient` wrapper that reads the site URL/email/API token from the credentials table
 * (Settings → Integrations) on every call instead of once at startup from env vars — same pattern as
 * `createGitClientFromCredentials` — so reconfiguring Jira in Settings takes effect on the next sync
 * tick without a backend restart.
 */
export function createJiraClientFromCredentials(credentialStore: CredentialStore): JiraClientService {
  return {
    async searchIssues(jql, maxResults) {
      const config = await credentialStore.getConfig("jira");
      if (!config?.baseUrl || !config.email || !config.apiToken) {
        throw new Error("Jira is not connected. Configure it in Settings → Integrations.");
      }
      return createJiraClient({ baseUrl: config.baseUrl, email: config.email, apiToken: config.apiToken }).searchIssues(
        jql,
        maxResults,
      );
    },
  };
}
