import { createDb } from "@chienkq/workflow-db";
import Fastify from "fastify";
import { env } from "./env.js";
import { createFactStore } from "./factStore.js";
import { createJiraClient } from "./jiraClient.js";
import { ensureWorkflowRow, runWorkflow, type RunnerServices } from "./runner.js";
import { scheduleJiraSync } from "./scheduler.js";
import { buildJiraSyncWorkflow, JIRA_SYNC_WORKFLOW_ID } from "./seedWorkflow.js";

const db = createDb(env.databaseUrl);
const jiraSyncWorkflow = buildJiraSyncWorkflow();
const services: RunnerServices = {
  jiraClient: createJiraClient({ baseUrl: env.jiraBaseUrl, email: env.jiraEmail, apiToken: env.jiraApiToken }),
  factStore: createFactStore(db),
};

await ensureWorkflowRow(db, jiraSyncWorkflow);
scheduleJiraSync(db, jiraSyncWorkflow, services);

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok" }));

app.post("/api/workflows/:id/run", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (id !== JIRA_SYNC_WORKFLOW_ID) return reply.code(404).send({ error: `Unknown workflow: ${id}` });

  try {
    const status = await runWorkflow(db, jiraSyncWorkflow, services, "manual");
    if (status === "error") return reply.code(502).send({ status, error: "Workflow run finished with a node error — see workflow_runs.output for details." });
    return { status };
  } catch (error) {
    return reply.code(500).send({ status: "error", error: error instanceof Error ? error.message : String(error) });
  }
});

await app.listen({ port: env.port, host: "0.0.0.0" });
