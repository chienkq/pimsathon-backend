import type { WorkflowDefinition } from "@chienkq/workflow-core";
import type { WorkflowDb } from "@chienkq/workflow-db";
import cron from "node-cron";
import { runWorkflow, type RunnerServices } from "./runner.js";

/** Every 15 minutes, matching W1's `updated >= -20m` JQL overlap window (see PM-workflow blueprint). */
export function scheduleJiraSync(db: WorkflowDb, workflow: WorkflowDefinition, services: RunnerServices): void {
  cron.schedule("*/15 * * * *", () => {
    runWorkflow(db, workflow, services, "schedule").catch((error) => {
      console.error("[scheduler] Jira Sync run failed:", error);
    });
  });
}
