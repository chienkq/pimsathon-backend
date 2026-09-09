import { inArray } from "drizzle-orm";
import { members, planningGroups, projects, workItems, type WorkflowDb } from "@chienkq/workflow-db";

/**
 * Canonical platform demo data — deliberately the SAME ids as admin-ui's own local seed
 * (`apps/admin-ui/src/domain/seed.ts`: members m1-m6, projects p1-p3), not a separate fake dataset.
 * This is what makes the admin-ui <-> backend connection real: admin-ui replaces its local
 * projects/members/workItems with this exact data on load (see `state/store.tsx`), so both sides
 * agree on identity. `cycleId`/`moduleIds` stay backend-only for now — admin-ui's write-back
 * (`domain/backendApi.ts`) deliberately never touches those two fields, so this milestone linkage
 * (used by W10) survives admin-ui edits to the same items.
 */
const OLD_DEMO_PROJECT_IDS = ["proj-pms", "proj-eng"];

const SEED_MEMBERS = [
  { id: "m1", name: "Alex Morgan", initials: "AM", color: "#4468d8", login: "alex-morgan" },
  { id: "m2", name: "Jamie Chen", initials: "JC", color: "#b87840", login: "jamie-chen" },
  { id: "m3", name: "Sam Rivera", initials: "SR", color: "#8170ae", login: "sam-rivera" },
  { id: "m4", name: "Taylor Kim", initials: "TK", color: "#368879", login: "taylor-kim" },
  { id: "m5", name: "Jordan Lee", initials: "JL", color: "#b76279", login: "jordan-lee" },
  { id: "m6", name: "Casey Park", initials: "CP", color: "#6a7c93", login: "casey-park" },
];

const SEED_PROJECTS = [
  { id: "p1", name: "Platform redesign", code: "PLT", description: "A clearer, faster home for the tools our teams use every day.", memberIds: ["m1", "m2", "m3", "m4"], color: "#496ce0", nextNumber: 5 },
  { id: "p2", name: "Developer experience", code: "DEV", description: "Make building and shipping great software feel effortless.", memberIds: ["m1", "m4", "m5", "m6"], color: "#8a6abd", nextNumber: 5 },
  { id: "p3", name: "Customer insights", code: "CX", description: "Turn customer feedback into a more thoughtful product.", memberIds: ["m2", "m3", "m5"], color: "#338f82", nextNumber: 1 },
];

const SEED_MODULES = [
  { id: "mod-p1-v1", projectId: "p1", kind: "module" as const, name: "Platform Redesign v1 Launch", startDate: "2026-08-01", endDate: "2026-09-05" },
  { id: "mod-p2-hardening", projectId: "p2", kind: "module" as const, name: "Developer Tooling Hardening", startDate: "2026-09-01", endDate: "2026-09-30" },
];

const SEED_CYCLES = [
  { id: "cyc-p1-sprint-9", projectId: "p1", kind: "cycle" as const, name: "Sprint 9", startDate: "2026-09-01", endDate: "2026-09-14", leadId: "m1" },
  { id: "cyc-p2-sprint-9", projectId: "p2", kind: "cycle" as const, name: "Sprint 9", startDate: "2026-09-01", endDate: "2026-09-14", leadId: "m4" },
];

const SEED_WORK_ITEMS = [
  { id: "wi-plt-1", projectId: "p1", number: 1, title: "Sprint burndown chart shows wrong remaining points", status: "In Progress", priority: "High", assigneeId: "m1", labels: ["bug"], cycleId: "cyc-p1-sprint-9", moduleIds: ["mod-p1-v1"], startDate: "2026-09-01", dueDate: "2026-09-08" },
  { id: "wi-plt-2", projectId: "p1", number: 2, title: "Add capacity field to team member profile", status: "Todo", priority: "Medium", assigneeId: "m2", labels: ["feature"], cycleId: "cyc-p1-sprint-9", moduleIds: ["mod-p1-v1"], startDate: "2026-09-08", dueDate: "2026-09-14" },
  { id: "wi-plt-3", projectId: "p1", number: 3, title: "Jira webhook signature verification fails intermittently", status: "In Review", priority: "Urgent", assigneeId: "m3", labels: ["bug", "security"], cycleId: "cyc-p1-sprint-9", moduleIds: ["mod-p1-v1"], startDate: "2026-09-02", dueDate: "2026-09-10" },
  { id: "wi-plt-4", projectId: "p1", number: 4, title: "Milestone widget doesn't account for skipped weekends", status: "Done", priority: "Low", assigneeId: "m1", labels: ["bug"], cycleId: "", moduleIds: ["mod-p1-v1"], startDate: "2026-08-15", dueDate: "2026-08-22" },
  { id: "wi-dev-1", projectId: "p2", number: 1, title: "Metis impact analysis times out on large diffs", status: "In Progress", priority: "High", assigneeId: "m4", labels: ["bug", "performance"], cycleId: "cyc-p2-sprint-9", moduleIds: ["mod-p2-hardening"], startDate: "2026-09-01", dueDate: "2026-09-09" },
  { id: "wi-dev-2", projectId: "p2", number: 2, title: "Flaky test: forecast Monte-Carlo seed not deterministic", status: "Todo", priority: "Medium", assigneeId: "", labels: ["bug"], cycleId: "cyc-p2-sprint-9", moduleIds: ["mod-p2-hardening"], startDate: "2026-09-10", dueDate: "2026-09-14" },
  { id: "wi-dev-3", projectId: "p2", number: 3, title: "SonarQube quality gate node ignores new-code period", status: "In Review", priority: "High", assigneeId: "m5", labels: ["bug"], cycleId: "cyc-p2-sprint-9", moduleIds: ["mod-p2-hardening"], startDate: "2026-09-03", dueDate: "2026-09-11" },
  // Left unscheduled on purpose: keeps the Timeline's "unscheduled" section demoable alongside the scheduled rows above.
  { id: "wi-dev-4", projectId: "p2", number: 4, title: "Agent guardrail: path allowlist bypassed via symlink", status: "Todo", priority: "Urgent", assigneeId: "m1", labels: ["bug", "security"], cycleId: "", moduleIds: ["mod-p2-hardening"], startDate: "", dueDate: "" },
] as const;

export async function seedPlatformData(db: WorkflowDb): Promise<void> {
  // One-time cleanup: drop the earlier fake PMS/ENG demo (predates the admin-ui identity unification).
  // Cascades to their work items and planning groups via FK onDelete: "cascade".
  await db.delete(projects).where(inArray(projects.id, OLD_DEMO_PROJECT_IDS));

  for (const member of SEED_MEMBERS) {
    await db.insert(members).values(member).onConflictDoNothing({ target: members.id });
  }
  for (const project of SEED_PROJECTS) {
    await db
      .insert(projects)
      .values({ ...project, memberIds: [...project.memberIds] })
      .onConflictDoUpdate({ target: projects.id, set: { memberIds: [...project.memberIds] } });
  }
  for (const module_ of SEED_MODULES) {
    await db
      .insert(planningGroups)
      .values({ ...module_, description: "", leadId: "" })
      .onConflictDoNothing({ target: planningGroups.id });
  }
  for (const cycle of SEED_CYCLES) {
    await db
      .insert(planningGroups)
      .values({ ...cycle, description: "" })
      .onConflictDoNothing({ target: planningGroups.id });
  }
  for (const item of SEED_WORK_ITEMS) {
    await db
      .insert(workItems)
      .values({ ...item, labels: [...item.labels], moduleIds: [...item.moduleIds], description: "" })
      // Only backfills `labels`/`moduleIds`/`cycleId`/dates on an existing row — status/priority/assignee
      // may have since been changed by admin-ui or a workflow, and re-seeding shouldn't stomp on that.
      .onConflictDoUpdate({
        target: workItems.id,
        set: {
          labels: [...item.labels],
          moduleIds: [...item.moduleIds],
          cycleId: item.cycleId,
          startDate: item.startDate,
          dueDate: item.dueDate,
        },
      });
  }
}
