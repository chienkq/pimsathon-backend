import type { WorkflowDb } from "@chienkq/workflow-db";
import cron from "node-cron";
import { resolveWorkflow, runWorkflow, type RunnerServices, type WorkflowSource } from "./runner.js";

export function scheduleWorkflow(
  db: WorkflowDb,
  workflowSource: WorkflowSource,
  cronExpression: string,
  services: RunnerServices,
  connectorProvider?: string,
): void {
  cron.schedule(cronExpression, () => {
    resolveWorkflow(workflowSource)
      .then((workflow) => runWorkflow(db, workflow, services, "schedule", connectorProvider))
      .catch((error) => {
        console.error(`[scheduler] run failed:`, error);
      });
  });
}
