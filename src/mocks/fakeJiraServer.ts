import Fastify from "fastify";

/**
 * Stands in for a real Jira Cloud site while no tenant/credentials exist yet. Speaks the same
 * `/rest/api/3/search` contract `jiraClient.ts` calls in production, so switching to a real Jira
 * later is just reconfiguring the Site URL in Settings → Integrations — no code changes to the
 * `jira` node or client.
 */

interface FakeIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    priority: { name: string };
    assignee: { displayName: string } | null;
    project: { key: string };
    updated: string;
  };
}

const ASSIGNEES = ["Nguyen Van A", "Tran Thi B", "Le Van C", null];
const now = Date.now();
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

const ISSUES: FakeIssue[] = [
  { key: "PMS-101", summary: "Sprint burndown chart shows wrong remaining points", status: "In Progress", priority: "High", project: "PMS", assignee: 0, updatedHoursAgo: 1 },
  { key: "PMS-102", summary: "Add capacity field to team member profile", status: "To Do", priority: "Medium", project: "PMS", assignee: 1, updatedHoursAgo: 6 },
  { key: "PMS-103", summary: "Jira webhook signature verification fails intermittently", status: "In Review", priority: "Urgent", project: "PMS", assignee: 2, updatedHoursAgo: 2 },
  { key: "PMS-104", summary: "Milestone widget doesn't account for skipped weekends", status: "Done", priority: "Low", project: "PMS", assignee: 0, updatedHoursAgo: 30 },
  { key: "ENG-201", summary: "Metis impact analysis times out on large diffs", status: "In Progress", priority: "High", project: "ENG", assignee: 1, updatedHoursAgo: 3 },
  { key: "ENG-202", summary: "Flaky test: forecast Monte-Carlo seed not deterministic", status: "To Do", priority: "Medium", project: "ENG", assignee: null, updatedHoursAgo: 12 },
  { key: "ENG-203", summary: "SonarQube quality gate node ignores new-code period", status: "In Review", priority: "High", project: "ENG", assignee: 2, updatedHoursAgo: 4 },
  { key: "ENG-204", summary: "Agent guardrail: path allowlist bypassed via symlink", status: "To Do", priority: "Urgent", project: "ENG", assignee: 0, updatedHoursAgo: 0.5 },
].map((raw, i) => ({
  id: String(1000 + i),
  key: raw.key,
  fields: {
    summary: raw.summary,
    status: { name: raw.status },
    priority: { name: raw.priority },
    assignee:
      raw.assignee === null
        ? null
        : { displayName: ASSIGNEES[raw.assignee as number] as string },
    project: { key: raw.project },
    updated: hoursAgo(raw.updatedHoursAgo),
  },
}));

const app = Fastify({ logger: true });

app.post("/rest/api/3/search", async (request, reply) => {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Basic ")) {
    return reply.code(401).send({ errorMessages: ["You do not have the permission to see the specified issue."] });
  }
  const body = request.body as { jql?: string; maxResults?: number } | undefined;
  const maxResults = body?.maxResults ?? 50;
  request.log.info({ jql: body?.jql, maxResults }, "fake Jira search");
  return { issues: ISSUES.slice(0, maxResults), total: ISSUES.length, maxResults };
});

const port = Number(process.env.FAKE_JIRA_PORT ?? 4001);
await app.listen({ port, host: "0.0.0.0" });
console.log(
  `Fake Jira listening at http://localhost:${port} — set Site URL to http://localhost:${port} in Settings → Integrations`,
);
