import { alerts, planningGroups, projects, workItems, type WorkflowDb } from "@chienkq/workflow-db";
import { and, desc, eq, like } from "drizzle-orm";

export interface GroupCount {
  group: string;
  count: number;
}

export interface MilestoneHealth {
  milestoneId: string;
  name: string;
  dueDate: string;
  total: number;
  done: number;
  percent: number;
  atRisk: boolean;
}

export interface ProjectAlert {
  id: string;
  dedupeKey: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  message: string;
  source: string;
  status: "open" | "closed";
  updatedAt: string;
}

export interface ProjectHealth {
  workload: GroupCount[];
  bugsByStatus: GroupCount[];
  bugsByPriority: GroupCount[];
  milestones: MilestoneHealth[];
  alerts: ProjectAlert[];
}

function countBy<T>(rows: T[], key: (row: T) => string): GroupCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const group = key(row);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts.entries()].map(([group, count]) => ({ group, count }));
}

/**
 * Same computations as W8 (Team Workload), W9 (Bug Metrics), W10 (Milestone Tracker), W11 (Alert
 * Engine) — just scoped to one project and computed live instead of read from the `widgets` table,
 * so a project's dashboard is always current without waiting for that workflow's next scheduled run.
 * Real data throughout: no fabricated/mock rows, everything is a live query over this project's
 * own `work_items`/`planning_groups`/`alerts`.
 */
export async function getProjectHealth(db: WorkflowDb, projectId: string): Promise<ProjectHealth> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error(`Project ${projectId} not found.`);

  const items = await db.select().from(workItems).where(eq(workItems.projectId, projectId));
  const openItems = items.filter((w) => w.status !== "Done" && w.status !== "Cancelled");
  const bugs = items.filter((w) => w.labels.includes("bug"));

  const workload = countBy(openItems, (w) => w.assigneeId || "(unassigned)");
  const bugsByStatus = countBy(bugs, (w) => w.status);
  const bugsByPriority = countBy(bugs, (w) => w.priority);

  const modules = await db
    .select()
    .from(planningGroups)
    .where(and(eq(planningGroups.projectId, projectId), eq(planningGroups.kind, "module")));
  const today = new Date().toISOString().slice(0, 10);
  const milestones: MilestoneHealth[] = modules.map((m) => {
    const linked = items.filter((w) => w.moduleIds.includes(m.id));
    const total = linked.length;
    const done = linked.filter((w) => w.status === "Done").length;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    const atRisk = Boolean(m.endDate) && today > m.endDate && percent < 100;
    return { milestoneId: m.id, name: m.name, dueDate: m.endDate, total, done, percent, atRisk };
  });

  // Alert dedupe keys are `${alertType}:${projectCode}-${number}` (see raiseAlert.ts) — filtering on
  // that suffix is how an alert (raised against a work item, not a project directly) maps back here.
  const projectAlerts = await db
    .select()
    .from(alerts)
    .where(like(alerts.dedupeKey, `%:${project.code}-%`))
    .orderBy(desc(alerts.updatedAt));

  return {
    workload,
    bugsByStatus,
    bugsByPriority,
    milestones,
    alerts: projectAlerts.map((a) => ({
      id: a.id,
      dedupeKey: a.dedupeKey,
      severity: a.severity,
      title: a.title,
      message: a.message,
      source: a.source,
      status: a.status,
      updatedAt: a.updatedAt.toISOString(),
    })),
  };
}
