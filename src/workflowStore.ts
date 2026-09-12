import {
  createEmptyWorkflow,
  toWorkflowSummary,
  type WorkflowDefinition,
  type WorkflowNodeDefinition,
  type WorkflowRepository,
  type WorkflowSummary,
} from "@chienkq/workflow-core";
import { workflows, type WorkflowDb } from "@chienkq/workflow-db";
import { desc, eq } from "drizzle-orm";

export interface WorkflowStore extends WorkflowRepository {
  /** Workflows whose first node has the given type — e.g. `"workItem"`, matching the convention every existing seed workflow (W8/W9/W10/W11) already uses for "this workflow's input is a work item". */
  listByInputNodeType(nodeType: string): Promise<WorkflowSummary[]>;
}

type WorkflowRow = typeof workflows.$inferSelect;

function toDomain(row: WorkflowRow): WorkflowDefinition {
  // `isSystem` lives in its own column, not the `definition` jsonb blob — the editor's save
  // round-trips only the fields it knows about (see useWorkflowEditorState.buildWorkflowDefinition),
  // so relying on the jsonb copy would silently lose the flag the first time someone saves the workflow.
  return { ...(row.definition as unknown as WorkflowDefinition), isSystem: row.isSystem };
}

/**
 * Postgres-backed `WorkflowRepository` — the server-side counterpart to workflow-core's
 * `LocalStorageWorkflowRepository`, so admin-ui's editor can read/write the same `workflows` table
 * this backend already schedules/runs registered workflows from (see runner.ts's `ensureWorkflowRow`).
 * `name`/`active` are kept as their own columns (for listing/filtering) in addition to living inside
 * the `definition` jsonb blob, which stays the single source of truth for the full shape.
 */
export function createWorkflowStore(db: WorkflowDb): WorkflowStore {
  return {
    async list() {
      const rows = await db.select().from(workflows).orderBy(desc(workflows.updatedAt));
      return rows.map((row) => toWorkflowSummary(toDomain(row)));
    },

    async get(id: string) {
      const [row] = await db.select().from(workflows).where(eq(workflows.id, id));
      return row ? toDomain(row) : undefined;
    },

    async create(name: string, initialNodes?: WorkflowNodeDefinition[]) {
      const workflow = createEmptyWorkflow(name, initialNodes);
      await db.insert(workflows).values({
        id: workflow.id,
        name: workflow.name,
        definition: workflow as unknown as Record<string, unknown>,
        active: workflow.active,
      });
      return workflow;
    },

    async save(workflow: WorkflowDefinition) {
      const updated: WorkflowDefinition = { ...workflow, updatedAt: new Date().toISOString() };
      const [row] = await db
        .update(workflows)
        .set({
          name: updated.name,
          active: updated.active,
          definition: updated as unknown as Record<string, unknown>,
          updatedAt: new Date(updated.updatedAt),
        })
        .where(eq(workflows.id, updated.id))
        .returning();
      if (!row) throw new Error(`Workflow ${updated.id} not found`);
      return toDomain(row);
    },

    async remove(id: string) {
      const [row] = await db.select().from(workflows).where(eq(workflows.id, id));
      if (row?.isSystem) throw new Error(`Workflow ${id} is a system workflow and cannot be deleted`);
      await db.delete(workflows).where(eq(workflows.id, id));
    },

    async duplicate(id: string) {
      const [source] = await db.select().from(workflows).where(eq(workflows.id, id));
      if (!source) throw new Error(`Workflow ${id} not found`);
      const now = new Date().toISOString();
      const copy: WorkflowDefinition = {
        ...toDomain(source),
        id: crypto.randomUUID(),
        name: `${source.name} (copy)`,
        active: false,
        // A copy of a system workflow is a regular, deletable workflow — not itself protected.
        isSystem: false,
        createdAt: now,
        updatedAt: now,
      };
      await db.insert(workflows).values({
        id: copy.id,
        name: copy.name,
        definition: copy as unknown as Record<string, unknown>,
        active: copy.active,
        isSystem: false,
      });
      return copy;
    },

    async listByInputNodeType(nodeType: string) {
      const rows = await db.select().from(workflows).orderBy(desc(workflows.updatedAt));
      return rows
        .map(toDomain)
        .filter((workflow) => workflow.nodes[0]?.type === nodeType)
        .map(toWorkflowSummary);
    },

    async setActive(id: string, active: boolean) {
      const [source] = await db.select().from(workflows).where(eq(workflows.id, id));
      if (!source) throw new Error(`Workflow ${id} not found`);
      const updated: WorkflowDefinition = { ...toDomain(source), active, updatedAt: new Date().toISOString() };
      const [row] = await db
        .update(workflows)
        .set({ active, definition: updated as unknown as Record<string, unknown>, updatedAt: new Date(updated.updatedAt) })
        .where(eq(workflows.id, id))
        .returning();
      return toDomain(row);
    },
  };
}
