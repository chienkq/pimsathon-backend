import type { AlertStoreService, NormalizedAlert } from "@chienkq/workflow-core";
import { alerts, type WorkflowDb } from "@chienkq/workflow-db";

/** Real Postgres-backed implementation of `services.alertStore` for the `raiseAlert` node. */
export function createAlertStore(db: WorkflowDb): AlertStoreService {
  return {
    async upsertAlert(alert: NormalizedAlert) {
      await db
        .insert(alerts)
        .values({ id: crypto.randomUUID(), ...alert, status: "open" })
        .onConflictDoUpdate({
          target: alerts.dedupeKey,
          set: {
            severity: alert.severity,
            title: alert.title,
            message: alert.message,
            status: "open",
            updatedAt: new Date(),
          },
        });
    },
  };
}
