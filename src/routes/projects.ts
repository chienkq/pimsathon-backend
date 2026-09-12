import { projects } from "@chienkq/workflow-db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";
import { getProjectHealth } from "../services/projectHealth.js";

function parseProjectInput(body: unknown): { name: string; code: string; description: string; memberIds: string[] } {
  const input = (body ?? {}) as Partial<{ name: string; code: string; description: string; memberIds: string[] }>;
  if (!input.name?.trim()) throw new Error("Name is required.");
  if (!input.code?.trim()) throw new Error("Code is required.");
  return {
    name: input.name.trim(),
    code: input.code.trim(),
    description: input.description?.trim() ?? "",
    memberIds: Array.isArray(input.memberIds) ? input.memberIds : [],
  };
}

export function registerProjectRoutes(app: FastifyInstance, ctx: BackendContext) {
  // Platform data — the same tables the `workItem` node reads/writes. admin-ui's `DemoProvider`
  // fetches these three on load and replaces its local projects/members/workItems with them (see
  // admin-ui's `state/store.tsx`), which is what makes the two sides agree on identity.
  app.get("/api/projects", async () => ({ projects: await ctx.db.select().from(projects) }));

  app.post("/api/projects", async (request, reply) => {
    try {
      const [project] = await ctx.db
        .insert(projects)
        .values({ id: crypto.randomUUID(), color: "#496ce0", nextNumber: 1, ...parseProjectInput(request.body) })
        .returning();
      return reply.code(201).send({ project });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [existing] = await ctx.db.select().from(projects).where(eq(projects.id, id));
    if (!existing) return reply.code(404).send({ error: `Unknown project: ${id}` });
    try {
      const [project] = await ctx.db
        .update(projects)
        .set(parseProjectInput(request.body))
        .where(eq(projects.id, id))
        .returning();
      return { project };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [existing] = await ctx.db.select().from(projects).where(eq(projects.id, id));
    if (!existing) return reply.code(404).send({ error: `Unknown project: ${id}` });
    await ctx.db.delete(projects).where(eq(projects.id, id));
    return { status: "success" };
  });

  // Per-project Project Health Dashboard data (workload, bugs, milestones, alerts) — see
  // services/projectHealth.ts for why this is computed live rather than read from the global `widgets` table.
  app.get("/api/projects/:id/health", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await getProjectHealth(ctx.db, id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // admin-ui's "connect a repository to a project" — the only write this backend accepts for
  // GitHub data today. The link lives on the project (one repo per project, but a repo can be
  // linked to several projects), so this is a project-scoped route. `repositoryId: null` disconnects;
  // setting it to a different repo re-points the project (this is how "change repository" works).
  app.patch("/api/projects/:id/repository", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { repositoryId } = request.body as { repositoryId: string | null | undefined };
    if (repositoryId === undefined)
      return reply.code(400).send({ error: "Body must include `repositoryId` (string or null)." });
    await ctx.db.update(projects).set({ repositoryId }).where(eq(projects.id, id));
    return { status: "success" };
  });
}
