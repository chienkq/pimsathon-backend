import type { WorkflowDefinition } from "@chienkq/workflow-core";
import type { WorkflowDb } from "@chienkq/workflow-db";
import cron from "node-cron";
import { runWorkflow, type RunnerServices } from "./runner.js";

export function scheduleWorkflow(
  db: WorkflowDb,
  workflow: WorkflowDefinition,
  cronExpression: string,
  services: RunnerServices,
  connectorProvider?: string,
): void {
  cron.schedule(cronExpression, () => {
    runWorkflow(db, workflow, services, "schedule", connectorProvider).catch((error) => {
      console.error(`[scheduler] "${workflow.name}" run failed:`, error);
    });
  });
}
