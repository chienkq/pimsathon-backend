import type { WorkflowDefinition } from "@chienkq/workflow-core";
import type { CredentialStore } from "./credentialStore.js";
import { env } from "./env.js";

export const JIRA_SYNC_WORKFLOW_ID = "w1-jira-sync";

/** W1 from the PM-workflow blueprint, trimmed to its minimal viable shape: jira -> ticketUpsert. */
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
        id: "ticketUpsert",
        type: "ticketUpsert",
        name: "Ticket Store — Upsert",
        position: { x: 260, y: 0 },
        parameters: { provider: "jira" },
      },
    ],
    connections: [{ id: "jira-to-ticketUpsert", source: "jira", target: "ticketUpsert" }],
  };
}

export const ALERT_ENGINE_WORKFLOW_ID = "w11-alert-engine";

const STALE_URGENT_RULE = `
// Urgent work items still open — reads from the platform's own work items via the Work Item node
// (admin-ui's ticket equivalent), not from an external tracker.
return items
  .filter((item) => item.json.priority === "Urgent" && item.json.status !== "Done")
  .map((item) => ({
    json: {
      ...item.json,
      severity: "critical",
      alertTitle: \`Urgent item still open: \${item.json.key} — \${item.json.title} (\${item.json.status})\`,
    },
  }));
`.trim();

/**
 * W11 from the PM-workflow blueprint: workItem (platform, List) -> code (rule) -> raiseAlert.
 * Reads admin-ui's own work items directly — no Jira/external sync in this path (see workItem.ts).
 */
export function buildAlertEngineWorkflow(): WorkflowDefinition {
  const now = new Date().toISOString();
  return {
    id: ALERT_ENGINE_WORKFLOW_ID,
    name: "Alert Engine",
    active: true,
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: "workItem",
        type: "workItem",
        name: "Work Item",
        position: { x: 0, y: 0 },
        parameters: { action: "List", priority: "Urgent" },
      },
      {
        id: "staleUrgentRule",
        type: "code",
        name: "Rule: Stale Urgent Item",
        position: { x: 260, y: 0 },
        parameters: { code: STALE_URGENT_RULE },
      },
      {
        id: "raiseAlert",
        type: "raiseAlert",
        name: "Raise Alert",
        position: { x: 520, y: 0 },
        parameters: {
          alertType: "stale-urgent-item",
          titleTemplate: "{{alertTitle}}",
          dedupeKeyField: "key",
          workItemIdField: "id",
          defaultSeverity: "high",
        },
      },
    ],
    connections: [
      { id: "workItem-to-rule", source: "workItem", target: "staleUrgentRule" },
      { id: "rule-to-raiseAlert", source: "staleUrgentRule", target: "raiseAlert" },
    ],
  };
}

export const TEAM_WORKLOAD_WORKFLOW_ID = "w8-team-workload";

const OPEN_ITEMS_ONLY = `
// Workload only counts work still open — a closed item isn't sitting on anyone's plate.
return items.filter((item) => item.json.status !== "Done" && item.json.status !== "Cancelled");
`.trim();

/**
 * W8 from the PM-workflow blueprint: workItem (platform, List) -> code (open-only) -> aggregate
 * (count by assignee) -> publishWidget. Same platform data source as W11 — no external sync needed.
 */
export function buildTeamWorkloadWorkflow(): WorkflowDefinition {
  const now = new Date().toISOString();
  return {
    id: TEAM_WORKLOAD_WORKFLOW_ID,
    name: "Team Workload",
    active: true,
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: "workItem",
        type: "workItem",
        name: "Work Item",
        position: { x: 0, y: 0 },
        parameters: { action: "List" },
      },
      {
        id: "openOnly",
        name: "Filter: Open Items Only",
        type: "code",
        position: { x: 260, y: 0 },
        parameters: { code: OPEN_ITEMS_ONLY },
      },
      {
        id: "aggregate",
        type: "aggregate",
        name: "Aggregate by Assignee",
        position: { x: 520, y: 0 },
        parameters: { groupByField: "assigneeId", emptyGroupLabel: "(unassigned)" },
      },
      {
        id: "publishWidget",
        type: "publishWidget",
        name: "Publish Widget",
        position: { x: 780, y: 0 },
        parameters: { widgetId: "team-workload", title: "Team Workload", type: "bar" },
      },
    ],
    connections: [
      { id: "workItem-to-filter", source: "workItem", target: "openOnly" },
      { id: "filter-to-aggregate", source: "openOnly", target: "aggregate" },
      { id: "aggregate-to-widget", source: "aggregate", target: "publishWidget" },
    ],
  };
}

export const BUG_METRICS_WORKFLOW_ID = "w9-bug-metrics";

const BUGS_ONLY = `
// "Bug" isn't its own field on a work item (see workItem.ts) — admin-ui tags it via labels, same
// as any other label. A second tracker with a real issue-type field would filter on that instead.
return items.filter((item) => Array.isArray(item.json.labels) && item.json.labels.includes("bug"));
`.trim();

/**
 * W9 from the PM-workflow blueprint: workItem (List) -> code (bugs only) -> fans out into two
 * aggregates (by status, by priority), each publishing its own widget. One filtered list feeding
 * two chart branches — proves nodes can fan out, not just chain 1:1.
 */
export function buildBugMetricsWorkflow(): WorkflowDefinition {
  const now = new Date().toISOString();
  return {
    id: BUG_METRICS_WORKFLOW_ID,
    name: "Bug Metrics",
    active: true,
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: "workItem",
        type: "workItem",
        name: "Work Item",
        position: { x: 0, y: 0 },
        parameters: { action: "List" },
      },
      {
        id: "bugsOnly",
        name: "Filter: Bugs Only",
        type: "code",
        position: { x: 260, y: 0 },
        parameters: { code: BUGS_ONLY },
      },
      {
        id: "aggregateByStatus",
        type: "aggregate",
        name: "Aggregate by Status",
        position: { x: 520, y: -80 },
        parameters: { groupByField: "status" },
      },
      {
        id: "publishByStatus",
        type: "publishWidget",
        name: "Publish Widget: Bugs by Status",
        position: { x: 780, y: -80 },
        parameters: { widgetId: "bugs-by-status", title: "Bugs by Status", type: "bar" },
      },
      {
        id: "aggregateByPriority",
        type: "aggregate",
        name: "Aggregate by Priority",
        position: { x: 520, y: 80 },
        parameters: { groupByField: "priority" },
      },
      {
        id: "publishByPriority",
        type: "publishWidget",
        name: "Publish Widget: Bugs by Priority",
        position: { x: 780, y: 80 },
        parameters: { widgetId: "bugs-by-priority", title: "Bugs by Priority", type: "pie" },
      },
    ],
    connections: [
      { id: "workItem-to-filter", source: "workItem", target: "bugsOnly" },
      { id: "filter-to-status", source: "bugsOnly", target: "aggregateByStatus" },
      { id: "status-to-widget", source: "aggregateByStatus", target: "publishByStatus" },
      { id: "filter-to-priority", source: "bugsOnly", target: "aggregateByPriority" },
      { id: "priority-to-widget", source: "aggregateByPriority", target: "publishByPriority" },
    ],
  };
}

export const MILESTONE_TRACKER_WORKFLOW_ID = "w10-milestone-tracker";

const MILESTONE_PROGRESS = `
// Both upstream nodes feed this one node, so \`items\` is the two lists concatenated — separate
// them back out by shape: only a work item has \`moduleIds\` (see workItem.ts / planningGroup.ts).
const milestones = items.filter((item) => item.json.moduleIds === undefined);
const workItemsList = items.filter((item) => item.json.moduleIds !== undefined);
const today = new Date().toISOString().slice(0, 10);

return milestones.map((m) => {
  const linked = workItemsList.filter(
    (w) => Array.isArray(w.json.moduleIds) && w.json.moduleIds.includes(m.json.id)
  );
  const total = linked.length;
  const done = linked.filter((w) => w.json.status === "Done").length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const dueDate = m.json.endDate;
  const atRisk = Boolean(dueDate) && today > dueDate && percent < 100;
  return {
    json: { milestoneId: m.json.id, name: m.json.name, projectId: m.json.projectId, dueDate, total, done, percent, atRisk },
  };
});
`.trim();

const AT_RISK_ONLY = `
return items
  .filter((item) => item.json.atRisk)
  .map((item) => ({
    json: {
      ...item.json,
      severity: "high",
      alertTitle: \`Milestone at risk: \${item.json.name} (\${item.json.percent}% done, due \${item.json.dueDate})\`,
    },
  }));
`.trim();

/**
 * W10 from the PM-workflow blueprint: planningGroup (List, kind=module) + workItem (List) both
 * feed one code node that computes %-done and at-risk per milestone, then fans out into a
 * dashboard widget and a Raise Alert for any milestone past its end date and not yet 100% done.
 */
export function buildMilestoneTrackerWorkflow(): WorkflowDefinition {
  const now = new Date().toISOString();
  return {
    id: MILESTONE_TRACKER_WORKFLOW_ID,
    name: "Milestone Tracker",
    active: true,
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: "planningGroup",
        type: "planningGroup",
        name: "Planning Group",
        position: { x: 0, y: -60 },
        parameters: { action: "List", kind: "module" },
      },
      {
        id: "workItem",
        type: "workItem",
        name: "Work Item",
        position: { x: 0, y: 60 },
        parameters: { action: "List" },
      },
      {
        id: "milestoneProgress",
        name: "Compute Milestone Progress",
        type: "code",
        position: { x: 260, y: 0 },
        parameters: { code: MILESTONE_PROGRESS },
      },
      {
        id: "publishWidget",
        type: "publishWidget",
        name: "Publish Widget",
        position: { x: 520, y: -60 },
        parameters: { widgetId: "milestones", title: "Milestones", type: "table" },
      },
      {
        id: "atRiskOnly",
        name: "Filter: At Risk Only",
        type: "code",
        position: { x: 520, y: 60 },
        parameters: { code: AT_RISK_ONLY },
      },
      {
        id: "raiseAlert",
        type: "raiseAlert",
        name: "Raise Alert",
        position: { x: 780, y: 60 },
        parameters: { alertType: "milestone-at-risk", titleTemplate: "{{alertTitle}}", dedupeKeyField: "milestoneId", defaultSeverity: "high" },
      },
    ],
    connections: [
      { id: "planningGroup-to-progress", source: "planningGroup", target: "milestoneProgress" },
      { id: "workItem-to-progress", source: "workItem", target: "milestoneProgress" },
      { id: "progress-to-widget", source: "milestoneProgress", target: "publishWidget" },
      { id: "progress-to-atrisk", source: "milestoneProgress", target: "atRiskOnly" },
      { id: "atrisk-to-alert", source: "atRiskOnly", target: "raiseAlert" },
    ],
  };
}

export const GITHUB_SYNC_WORKFLOW_ID = "w3-github-sync";

/**
 * W3 from the PM-workflow blueprint: 4 independent git(read) -> gitCacheUpsert chains, one per
 * entity (repository info, branches, PRs, issues) — read-only for now (no Create Issue/Branch/PR
 * wired in yet). `owner`/`repo` come from the Integrations screen's stored GitHub credential (see
 * `buildGitHubSyncWorkflowFromCredentials`), not env vars — rebuilt fresh on every scheduled run so
 * a reconfigure in Settings takes effect on the next tick.
 */
export function buildGitHubSyncWorkflow(owner: string, repo: string): WorkflowDefinition {
  const now = new Date().toISOString();
  return {
    id: GITHUB_SYNC_WORKFLOW_ID,
    name: "GitHub Sync",
    active: true,
    createdAt: now,
    updatedAt: now,
    nodes: [
      { id: "getRepo", type: "git", name: "Git: Get Repository", position: { x: 0, y: -180 }, parameters: { action: "Get Repository", owner, repo } },
      { id: "cacheRepo", type: "gitCacheUpsert", name: "Cache: Repository", position: { x: 260, y: -180 }, parameters: { entity: "Repository", owner, repo } },

      { id: "listBranches", type: "git", name: "Git: List Branches", position: { x: 0, y: -60 }, parameters: { action: "List Branches", owner, repo } },
      { id: "cacheBranches", type: "gitCacheUpsert", name: "Cache: Branches", position: { x: 260, y: -60 }, parameters: { entity: "Branches", owner, repo } },

      { id: "listPRs", type: "git", name: "Git: List Pull Requests", position: { x: 0, y: 60 }, parameters: { action: "List Pull Requests", owner, repo, state: "all" } },
      { id: "cachePRs", type: "gitCacheUpsert", name: "Cache: Pull Requests", position: { x: 260, y: 60 }, parameters: { entity: "Pull Requests", owner, repo } },

      { id: "listIssues", type: "git", name: "Git: List Issues", position: { x: 0, y: 180 }, parameters: { action: "List Issues", owner, repo, state: "all" } },
      { id: "cacheIssues", type: "gitCacheUpsert", name: "Cache: Issues", position: { x: 260, y: 180 }, parameters: { entity: "Issues", owner, repo } },
    ],
    connections: [
      { id: "repo-to-cache", source: "getRepo", target: "cacheRepo" },
      { id: "branches-to-cache", source: "listBranches", target: "cacheBranches" },
      { id: "prs-to-cache", source: "listPRs", target: "cachePRs" },
      { id: "issues-to-cache", source: "listIssues", target: "cacheIssues" },
    ],
  };
}

/** Reads the `github` row from the credentials table (owner/repo fields) and builds W3 against it. */
export async function buildGitHubSyncWorkflowFromCredentials(credentialStore: CredentialStore): Promise<WorkflowDefinition> {
  const config = await credentialStore.getConfig("github");
  return buildGitHubSyncWorkflow(config?.owner ?? "", config?.repo ?? "");
}
