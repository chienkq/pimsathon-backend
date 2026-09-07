import type { WorkflowDefinition } from "@chienkq/workflow-core";
import { env } from "./env.js";

export const JIRA_SYNC_WORKFLOW_ID = "w1-jira-sync";

/** W1 from the PM-workflow blueprint, trimmed to its minimal viable shape: jira -> factUpsert. */
export function buildJiraSyncWorkflow(): WorkflowDefinition {
  const now = new Date().toISOString();
  return {
    id: JIRA_SYNC_WORKFLOW_ID,
    name: "Jira Sync",
    active: true,
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: "jira",
        type: "jira",
        name: "Jira",
        position: { x: 0, y: 0 },
        parameters: { jqlQuery: env.jiraJqlQuery, maxResults: 100 },
      },
      {
        id: "factUpsert",
        type: "factUpsert",
        name: "Fact Store — Upsert",
        position: { x: 260, y: 0 },
        parameters: { provider: "jira" },
      },
    ],
    connections: [{ id: "jira-to-factUpsert", source: "jira", target: "factUpsert" }],
  };
}
