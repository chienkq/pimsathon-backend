import type { WorkflowDefinition } from "@chienkq/workflow-core";

export const ANALYZE_CYCLE_WORKFLOW_ID = "w12-analyze-cycle";
export const ANALYZE_MODULE_WORKFLOW_ID = "w13-analyze-module";

/**
 * Rule-based health computation, shared shape between Analyze Cycle and Analyze Module (see
 * `docs/pm-workitem-workflows.md`'s output schema: status/healthScore/summary/risks/
 * recommendedActions/needsAlert/alertSeverity). `sendMessageToAiAgent` is still a stub today (see
 * `nodeTypes/sendMessageToAiAgent.ts`) — real LLM wiring is a separate, later piece of work — so the
 * numbers/status/risks below are computed deterministically from real data, and the AI step's
 * `response` is folded in as an additional line rather than replacing the computed summary. Once a
 * real AI client exists, swap that one line for the AI's own summary/recommendedActions.
 */
const COMPUTE_CYCLE_HEALTH = `
// Both upstream nodes feed this one node — separate them back out by shape (only a planning group
// has \`kind\`, see planningGroup.ts / workItem.ts).
const cycles = items.filter((item) => item.json.kind !== undefined);
const workItemsList = items.filter((item) => item.json.kind === undefined);
const today = new Date().toISOString().slice(0, 10);

return cycles.map((c) => {
  const linked = workItemsList.filter((w) => w.json.cycleId === c.json.id);
  const total = linked.length;
  const done = linked.filter((w) => w.json.status === "Done").length;
  const overdue = linked.filter((w) => w.json.dueDate && w.json.dueDate < today && w.json.status !== "Done").length;
  const totalPoints = linked.reduce((sum, w) => sum + (Number(w.json.storyPoints) || 0), 0);
  const donePoints = linked
    .filter((w) => w.json.status === "Done")
    .reduce((sum, w) => sum + (Number(w.json.storyPoints) || 0), 0);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const pastDeadline = Boolean(c.json.endDate) && today > c.json.endDate;

  const risks = [];
  if (overdue > 0) risks.push({ title: \`\${overdue} work item(s) past due date\`, relatedWorkItemIds: linked.filter((w) => w.json.dueDate && w.json.dueDate < today && w.json.status !== "Done").map((w) => w.json.id) });
  if (pastDeadline && percent < 100) risks.push({ title: \`Cycle end date (\${c.json.endDate}) has passed at \${percent}% done\` });

  let status = "on_track";
  if (pastDeadline && percent < 100) status = "off_track";
  else if (overdue > 0 || (percent < 50 && !pastDeadline)) status = "at_risk";

  const healthScore = Math.max(0, Math.min(100, percent - overdue * 10 - (pastDeadline && percent < 100 ? 30 : 0)));
  const needsAlert = status !== "on_track";

  return {
    json: {
      subjectId: c.json.id,
      name: c.json.name,
      projectId: c.json.projectId,
      endDate: c.json.endDate,
      total,
      done,
      overdue,
      totalPoints,
      donePoints,
      percent,
      status,
      healthScore,
      risks,
      completionDate: c.json.endDate,
      recommendedActions: overdue > 0 ? ["Re-prioritize or re-scope the overdue items"] : [],
      needsAlert,
      alertSeverity: status === "off_track" ? "high" : status === "at_risk" ? "medium" : "low",
    },
  };
});
`.trim();

const AI_PROMPT_CYCLE = `
return items.map((item) => ({
  json: {
    ...item.json,
    aiMessage: \`Cycle "\${item.json.name}": \${item.json.done}/\${item.json.total} items done (\${item.json.percent}%), \${item.json.overdue} overdue, story points \${item.json.donePoints}/\${item.json.totalPoints}. Assess status and suggest actions.\`,
  },
}));
`.trim();

const ASSEMBLE_CYCLE_RESULT = `
// Folds the AI agent's (currently stub) response into the summary computed by the rule step above —
// once sendMessageToAiAgent calls a real model, its response becomes the actual narrative summary.
return items.map((item) => ({
  json: {
    ...item.json,
    summary: \`\${item.json.status.replace("_", " ")} — \${item.json.done}/\${item.json.total} done, \${item.json.overdue} overdue. \${item.json.response ?? ""}\`,
  },
}));
`.trim();

const NEEDS_ALERT_IF_PARAMETERS = { field: "needsAlert", operator: "equals", value: "true" };

/**
 * "Analyze Cycle" from `pm-workitem-workflows.md`: planningGroup(cycle) + workItem -> code (compute
 * health) -> sendMessageToAiAgent (narrative, stub until real AI wiring) -> code (assemble) ->
 * analysisResultSave -> if(needsAlert) -> raiseAlert.
 */
export function buildAnalyzeCycleWorkflow(): WorkflowDefinition {
  const now = new Date().toISOString();
  return {
    id: ANALYZE_CYCLE_WORKFLOW_ID,
    name: "Analyze Cycle",
    active: true,
    createdAt: now,
    updatedAt: now,
    nodes: [
      { id: "planningGroup", type: "planningGroup", name: "Planning Group", position: { x: 0, y: -60 }, parameters: { action: "List", kind: "cycle" } },
      { id: "workItem", type: "workItem", name: "Work Item", position: { x: 0, y: 60 }, parameters: { action: "List" } },
      { id: "computeHealth", type: "code", name: "Compute Cycle Health", position: { x: 260, y: 0 }, parameters: { code: COMPUTE_CYCLE_HEALTH } },
      { id: "aiPrompt", type: "code", name: "Build AI Prompt", position: { x: 520, y: 0 }, parameters: { code: AI_PROMPT_CYCLE } },
      {
        id: "aiAgent",
        type: "sendMessageToAiAgent",
        name: "Send Message to AI Agent",
        position: { x: 780, y: 0 },
        // `message` is one fixed string for the whole node (no per-item templating exists yet — see
        // n8n_clone_gap_tracker item 12, the expression editor), so it can't literally read the
        // `aiMessage` field the previous step computed per item. Once a real AI client and a per-item
        // expression editor both exist, point this at `aiMessage` instead of this generic instruction.
        parameters: { agentName: "cycle-health-analyst", message: "Assess each cycle's health from its stats and suggest actions." },
      },
      { id: "assembleResult", type: "code", name: "Assemble Analysis Result", position: { x: 1040, y: 0 }, parameters: { code: ASSEMBLE_CYCLE_RESULT } },
      { id: "saveResult", type: "analysisResultSave", name: "Analysis Result — Save", position: { x: 1300, y: 0 }, parameters: { subjectType: "cycle" } },
      { id: "needsAlert", type: "if", name: "If: Needs Alert", position: { x: 1560, y: 0 }, parameters: NEEDS_ALERT_IF_PARAMETERS },
      {
        id: "raiseAlert",
        type: "raiseAlert",
        name: "Raise Alert",
        position: { x: 1820, y: 0 },
        parameters: { alertType: "cycle-at-risk", titleTemplate: "Cycle at risk: {{name}} ({{status}})", dedupeKeyField: "subjectId", defaultSeverity: "medium" },
      },
    ],
    connections: [
      { id: "planningGroup-to-health", source: "planningGroup", target: "computeHealth" },
      { id: "workItem-to-health", source: "workItem", target: "computeHealth" },
      { id: "health-to-prompt", source: "computeHealth", target: "aiPrompt" },
      { id: "prompt-to-agent", source: "aiPrompt", target: "aiAgent" },
      { id: "agent-to-assemble", source: "aiAgent", target: "assembleResult" },
      // Fan out from the assembled result, not chained through Save first — `analysisResultSave`'s
      // output is the canonical stored row (id/subjectId/status/...), which drops fields like `name`
      // that only the pre-save item had and that the alert's title template still needs.
      { id: "assemble-to-save", source: "assembleResult", target: "saveResult" },
      { id: "assemble-to-if", source: "assembleResult", target: "needsAlert" },
      { id: "if-to-alert", source: "needsAlert", target: "raiseAlert", sourceOutput: "true" },
    ],
  };
}

const COMPUTE_MODULE_HEALTH = `
const modules = items.filter((item) => item.json.kind !== undefined);
const workItemsList = items.filter((item) => item.json.kind === undefined);

return modules.map((m) => {
  const linked = workItemsList.filter((w) => Array.isArray(w.json.moduleIds) && w.json.moduleIds.includes(m.json.id));
  const total = linked.length;
  const done = linked.filter((w) => w.json.status === "Done").length;
  const bugs = linked.filter((w) => Array.isArray(w.json.labels) && w.json.labels.includes("bug")).length;
  const blocked = linked.filter((w) => Array.isArray(w.json.labels) && w.json.labels.includes("blocked")).length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  const risks = [];
  if (blocked > 0) risks.push({ title: \`\${blocked} work item(s) marked blocked\` });
  if (bugs > total * 0.3 && total > 0) risks.push({ title: \`High bug ratio: \${bugs}/\${total} items are bugs\` });

  let status = "on_track";
  if (blocked > 0) status = "off_track";
  else if (bugs > total * 0.3 && total > 0) status = "at_risk";

  const healthScore = Math.max(0, Math.min(100, percent - blocked * 15 - bugs * 5));
  const needsAlert = status !== "on_track";

  return {
    json: {
      subjectId: m.json.id,
      name: m.json.name,
      projectId: m.json.projectId,
      total,
      done,
      bugs,
      blocked,
      percent,
      status,
      healthScore,
      risks,
      recommendedActions: blocked > 0 ? ["Unblock the flagged work items before continuing"] : [],
      needsAlert,
      alertSeverity: status === "off_track" ? "high" : status === "at_risk" ? "medium" : "low",
    },
  };
});
`.trim();

const AI_PROMPT_MODULE = `
return items.map((item) => ({
  json: {
    ...item.json,
    aiMessage: \`Module "\${item.json.name}": \${item.json.done}/\${item.json.total} items done (\${item.json.percent}%), \${item.json.bugs} bugs, \${item.json.blocked} blocked. Assess status and suggest actions.\`,
  },
}));
`.trim();

const ASSEMBLE_MODULE_RESULT = `
return items.map((item) => ({
  json: {
    ...item.json,
    summary: \`\${item.json.status.replace("_", " ")} — \${item.json.done}/\${item.json.total} done, \${item.json.blocked} blocked, \${item.json.bugs} bugs. \${item.json.response ?? ""}\`,
  },
}));
`.trim();

/**
 * "Analyze Module" from `pm-workitem-workflows.md` — same shape as Analyze Cycle but keyed on
 * `moduleIds` and quality/dependency signals (bug label ratio, "blocked" label) instead of a hard
 * deadline. Deliberately a NEW workflow rather than a rewrite of the existing rule-based Milestone
 * Tracker (`w10-milestone-tracker`, see the node/workflow audit) — Milestone Tracker keeps publishing
 * its dashboard widget unchanged; this one is the doc's fuller analysis + alerting path.
 */
export function buildAnalyzeModuleWorkflow(): WorkflowDefinition {
  const now = new Date().toISOString();
  return {
    id: ANALYZE_MODULE_WORKFLOW_ID,
    name: "Analyze Module",
    active: true,
    createdAt: now,
    updatedAt: now,
    nodes: [
      { id: "planningGroup", type: "planningGroup", name: "Planning Group", position: { x: 0, y: -60 }, parameters: { action: "List", kind: "module" } },
      { id: "workItem", type: "workItem", name: "Work Item", position: { x: 0, y: 60 }, parameters: { action: "List" } },
      { id: "computeHealth", type: "code", name: "Compute Module Health", position: { x: 260, y: 0 }, parameters: { code: COMPUTE_MODULE_HEALTH } },
      { id: "aiPrompt", type: "code", name: "Build AI Prompt", position: { x: 520, y: 0 }, parameters: { code: AI_PROMPT_MODULE } },
      {
        id: "aiAgent",
        type: "sendMessageToAiAgent",
        name: "Send Message to AI Agent",
        position: { x: 780, y: 0 },
        // See the equivalent node in buildAnalyzeCycleWorkflow for why `message` is a fixed string.
        parameters: { agentName: "module-health-analyst", message: "Assess each module's health from its stats and suggest actions." },
      },
      { id: "assembleResult", type: "code", name: "Assemble Analysis Result", position: { x: 1040, y: 0 }, parameters: { code: ASSEMBLE_MODULE_RESULT } },
      { id: "saveResult", type: "analysisResultSave", name: "Analysis Result — Save", position: { x: 1300, y: 0 }, parameters: { subjectType: "module" } },
      { id: "needsAlert", type: "if", name: "If: Needs Alert", position: { x: 1560, y: 0 }, parameters: NEEDS_ALERT_IF_PARAMETERS },
      {
        id: "raiseAlert",
        type: "raiseAlert",
        name: "Raise Alert",
        position: { x: 1820, y: 0 },
        parameters: { alertType: "module-at-risk", titleTemplate: "Module at risk: {{name}} ({{status}})", dedupeKeyField: "subjectId", defaultSeverity: "medium" },
      },
    ],
    connections: [
      { id: "planningGroup-to-health", source: "planningGroup", target: "computeHealth" },
      { id: "workItem-to-health", source: "workItem", target: "computeHealth" },
      { id: "health-to-prompt", source: "computeHealth", target: "aiPrompt" },
      { id: "prompt-to-agent", source: "aiPrompt", target: "aiAgent" },
      { id: "agent-to-assemble", source: "aiAgent", target: "assembleResult" },
      // Fan out from the assembled result, not chained through Save first — `analysisResultSave`'s
      // output is the canonical stored row (id/subjectId/status/...), which drops fields like `name`
      // that only the pre-save item had and that the alert's title template still needs.
      { id: "assemble-to-save", source: "assembleResult", target: "saveResult" },
      { id: "assemble-to-if", source: "assembleResult", target: "needsAlert" },
      { id: "if-to-alert", source: "needsAlert", target: "raiseAlert", sourceOutput: "true" },
    ],
  };
}
