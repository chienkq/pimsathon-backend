import { alerts, branches, commits, planningGroups, projects, pullRequests, workItems, type WorkflowDb } from "@chienkq/workflow-db";
import { and, desc, eq, gte, inArray, like, or } from "drizzle-orm";
import { queryLatestForSubjects } from "../store/analysisResultStore.js";

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

export interface CycleHealth {
  cycleId: string;
  name: string;
  endDate: string;
  totalItems: number;
  doneItems: number;
  totalPoints: number;
  donePoints: number;
  percent: number;
  atRisk: boolean;
}

export interface VelocityPoint {
  cycleId: string;
  name: string;
  endDate: string;
  completedItems: number;
  completedPoints: number;
}

export interface OverdueItem {
  id: string;
  title: string;
  assigneeId: string;
  dueDate: string;
  daysOverdue: number;
}

export interface BlockedItem {
  id: string;
  title: string;
  assigneeId: string;
}

export interface DevActivity {
  openPRCount: number;
  mergedPRCount: number;
  closedPRCount: number;
  commitsLast7Days: number;
  dailyCommitCounts: { date: string; count: number }[];
}

export interface AnalysisRollupSubject {
  subjectType: "cycle" | "module";
  subjectId: string;
  name: string;
  status: "on_track" | "at_risk" | "off_track";
  healthScore: number;
}

export interface AnalysisRollupRisk {
  subjectType: "cycle" | "module";
  subjectId: string;
  name: string;
  title: string;
  detail?: string;
}

export interface AnalysisRollup {
  avgHealthScore: number | null;
  worstStatus: "on_track" | "at_risk" | "off_track" | null;
  subjects: AnalysisRollupSubject[];
  risks: AnalysisRollupRisk[];
  recommendedActions: string[];
}

export interface ProjectAlert {
  id: string;
  dedupeKey: string;
  workItemId: string | null;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  message: string;
  source: string;
  status: "open" | "closed";
  updatedAt: string;
}

export interface ProjectHealth {
  workload: GroupCount[];
  milestones: MilestoneHealth[];
  cycles: CycleHealth[];
  velocity: VelocityPoint[];
  overdueItems: OverdueItem[];
  blockedItems: BlockedItem[];
  devActivity: DevActivity;
  analysisRollup: AnalysisRollup;
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

const STATUS_RANK: Record<AnalysisRollupSubject["status"], number> = { on_track: 0, at_risk: 1, off_track: 2 };

/**
 * Same computations as W8 (Team Workload), W9 (Bug Metrics), W10 (Milestone Tracker), W11 (Alert
 * Engine) — just scoped to one project and computed live instead of read from the `widgets` table,
 * so a project's dashboard is always current without waiting for that workflow's next scheduled run.
 * Real data throughout: no fabricated/mock rows, everything is a live query over this project's
 * own `work_items`/`planning_groups`/`alerts`/git-cache tables, plus the latest `analysis_results`
 * snapshots written by the Analyze Cycle / Analyze Module workflows (W12/W13).
 */
export async function getProjectHealth(db: WorkflowDb, projectId: string): Promise<ProjectHealth> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error(`Project ${projectId} not found.`);

  const items = await db.select().from(workItems).where(eq(workItems.projectId, projectId));
  const openItems = items.filter((w) => w.status !== "Done" && w.status !== "Cancelled");

  const workload = countBy(openItems, (w) => w.assigneeId || "(unassigned)");

  const today = new Date().toISOString().slice(0, 10);

  const modules = await db
    .select()
    .from(planningGroups)
    .where(and(eq(planningGroups.projectId, projectId), eq(planningGroups.kind, "module")));
  const milestones: MilestoneHealth[] = modules.map((m) => {
    const linked = items.filter((w) => w.moduleIds.includes(m.id));
    const total = linked.length;
    const done = linked.filter((w) => w.status === "Done").length;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    const atRisk = Boolean(m.endDate) && today > m.endDate && percent < 100;
    return { milestoneId: m.id, name: m.name, dueDate: m.endDate, total, done, percent, atRisk };
  });

  // Cycles mirror the module/Milestones computation above, but items link via the scalar
  // `cycleId` field instead of the `moduleIds` array, and additionally roll up `storyPoints`
  // (no status-history table exists, so this is a current-state snapshot, not a burndown).
  const cyclesRaw = await db
    .select()
    .from(planningGroups)
    .where(and(eq(planningGroups.projectId, projectId), eq(planningGroups.kind, "cycle")));
  const cycles: CycleHealth[] = cyclesRaw.map((c) => {
    const linked = items.filter((w) => w.cycleId === c.id);
    const totalItems = linked.length;
    const doneItems = linked.filter((w) => w.status === "Done").length;
    const totalPoints = linked.reduce((sum, w) => sum + (w.storyPoints ?? 0), 0);
    const donePoints = linked.filter((w) => w.status === "Done").reduce((sum, w) => sum + (w.storyPoints ?? 0), 0);
    const percent = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;
    const atRisk = Boolean(c.endDate) && today > c.endDate && percent < 100;
    return { cycleId: c.id, name: c.name, endDate: c.endDate, totalItems, doneItems, totalPoints, donePoints, percent, atRisk };
  });

  // Velocity trend: completed story points per already-ended cycle, oldest to newest, last 6.
  const velocity: VelocityPoint[] = cyclesRaw
    .filter((c) => c.endDate && c.endDate < today)
    .sort((a, b) => a.endDate.localeCompare(b.endDate))
    .slice(-6)
    .map((c) => {
      const linked = items.filter((w) => w.cycleId === c.id && w.status === "Done");
      return {
        cycleId: c.id,
        name: c.name,
        endDate: c.endDate,
        completedItems: linked.length,
        completedPoints: linked.reduce((sum, w) => sum + (w.storyPoints ?? 0), 0),
      };
    });

  const overdueItems: OverdueItem[] = openItems
    .filter((w) => w.dueDate && w.dueDate < today)
    .map((w) => ({
      id: w.id,
      title: w.title,
      assigneeId: w.assigneeId || "(unassigned)",
      dueDate: w.dueDate,
      daysOverdue: Math.floor((Date.parse(today) - Date.parse(w.dueDate)) / 86_400_000),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  const blockedItems: BlockedItem[] = openItems
    .filter((w) => w.labels.includes("blocked"))
    .map((w) => ({ id: w.id, title: w.title, assigneeId: w.assigneeId || "(unassigned)" }));

  // Dev activity: branches/PRs link to work items via `workItemId`, so we can scope them to this
  // project's items without needing a repository<->project relationship. PRs only carry `syncedAt`
  // (last sync time, not creation/merge time), so PR counts are a current snapshot, not time-boxed;
  // only `commits.at` is a real event timestamp, so only commit activity can be windowed.
  const itemIds = items.map((w) => w.id);
  const projectPullRequests =
    itemIds.length > 0 ? await db.select().from(pullRequests).where(inArray(pullRequests.workItemId, itemIds)) : [];
  const projectBranches =
    itemIds.length > 0 ? await db.select().from(branches).where(inArray(branches.workItemId, itemIds)) : [];
  const branchIds = projectBranches.map((b) => b.id);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  const recentCommits =
    branchIds.length > 0
      ? await db.select().from(commits).where(and(inArray(commits.branchId, branchIds), gte(commits.at, sevenDaysAgo)))
      : [];
  const dailyCounts = new Map<string, number>();
  for (let i = 6; i >= 0; i--) {
    dailyCounts.set(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), 0);
  }
  for (const c of recentCommits) {
    const day = c.at.toISOString().slice(0, 10);
    if (dailyCounts.has(day)) dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + 1);
  }
  const devActivity: DevActivity = {
    openPRCount: projectPullRequests.filter((p) => p.status === "Open").length,
    mergedPRCount: projectPullRequests.filter((p) => p.status === "Merged").length,
    closedPRCount: projectPullRequests.filter((p) => p.status === "Closed").length,
    commitsLast7Days: recentCommits.length,
    dailyCommitCounts: [...dailyCounts.entries()].map(([date, count]) => ({ date, count })),
  };

  // AI health rollup: latest analysis_results snapshot per cycle/module, from the Analyze
  // Cycle/Analyze Module workflows (W12/W13) — a separate, richer mechanism from the rule-based
  // milestones/cycles computed above.
  const [cycleAnalyses, moduleAnalyses] = await Promise.all([
    queryLatestForSubjects(
      db,
      "cycle",
      cyclesRaw.map((c) => c.id)
    ),
    queryLatestForSubjects(
      db,
      "module",
      modules.map((m) => m.id)
    ),
  ]);
  const analysisSubjects: AnalysisRollupSubject[] = [
    ...cycleAnalyses.map((a) => ({
      subjectType: "cycle" as const,
      subjectId: a.subjectId,
      name: cyclesRaw.find((c) => c.id === a.subjectId)?.name ?? a.subjectId,
      status: a.status,
      healthScore: a.healthScore,
    })),
    ...moduleAnalyses.map((a) => ({
      subjectType: "module" as const,
      subjectId: a.subjectId,
      name: modules.find((m) => m.id === a.subjectId)?.name ?? a.subjectId,
      status: a.status,
      healthScore: a.healthScore,
    })),
  ];
  const analysisRollup: AnalysisRollup = {
    avgHealthScore: analysisSubjects.length
      ? Math.round(analysisSubjects.reduce((sum, s) => sum + s.healthScore, 0) / analysisSubjects.length)
      : null,
    worstStatus: analysisSubjects.length
      ? analysisSubjects.reduce((worst, s) => (STATUS_RANK[s.status] > STATUS_RANK[worst] ? s.status : worst), "on_track" as AnalysisRollupSubject["status"])
      : null,
    subjects: analysisSubjects,
    risks: [
      ...cycleAnalyses.flatMap((a) =>
        a.risks.map((r) => ({
          subjectType: "cycle" as const,
          subjectId: a.subjectId,
          name: cyclesRaw.find((c) => c.id === a.subjectId)?.name ?? a.subjectId,
          title: r.title,
          detail: r.detail,
        }))
      ),
      ...moduleAnalyses.flatMap((a) =>
        a.risks.map((r) => ({
          subjectType: "module" as const,
          subjectId: a.subjectId,
          name: modules.find((m) => m.id === a.subjectId)?.name ?? a.subjectId,
          title: r.title,
          detail: r.detail,
        }))
      ),
    ],
    recommendedActions: [...cycleAnalyses, ...moduleAnalyses].flatMap((a) => a.recommendedActions),
  };

  // An alert maps back to this project either via `workItemId` (set when the raising workflow's
  // `raiseAlert` node has a `workItemIdField`, e.g. the analyze-work-item workflows) or, for
  // alerts raised directly against a work item's human-readable key (dedupe key
  // `${alertType}:${projectCode}-${number}`, see raiseAlert.ts / W11), via a `dedupeKey` suffix match.
  const projectAlerts = await db
    .select()
    .from(alerts)
    .where(
      or(
        itemIds.length > 0 ? inArray(alerts.workItemId, itemIds) : undefined,
        like(alerts.dedupeKey, `%:${project.code}-%`)
      )
    )
    .orderBy(desc(alerts.updatedAt));

  return {
    workload,
    milestones,
    cycles,
    velocity,
    overdueItems,
    blockedItems,
    devActivity,
    analysisRollup,
    alerts: projectAlerts.map((a) => ({
      id: a.id,
      dedupeKey: a.dedupeKey,
      workItemId: a.workItemId,
      severity: a.severity,
      title: a.title,
      message: a.message,
      source: a.source,
      status: a.status,
      updatedAt: a.updatedAt.toISOString(),
    })),
  };
}
