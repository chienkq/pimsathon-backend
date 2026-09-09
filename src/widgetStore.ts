import type { NormalizedWidget, WidgetStoreService } from "@chienkq/workflow-core";
import { widgets, type WorkflowDb } from "@chienkq/workflow-db";

/** Real Postgres-backed implementation of `services.widgetStore` for the `publishWidget` node. */
export function createWidgetStore(db: WorkflowDb): WidgetStoreService {
  return {
    async publish(widget: NormalizedWidget) {
      await db
        .insert(widgets)
        .values({ ...widget, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: widgets.widgetId,
          set: { title: widget.title, type: widget.type, series: widget.series, updatedAt: new Date() },
        });
    },
  };
}
