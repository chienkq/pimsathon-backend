import { members } from "@chienkq/workflow-db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";

function parseMemberInput(body: unknown): { name: string; initials: string; color: string; login: string } {
  const input = (body ?? {}) as Partial<{ name: string; initials: string; color: string; login: string }>;
  if (!input.name?.trim()) throw new Error("Name is required.");
  if (!input.login?.trim()) throw new Error("Login is required.");
  const name = input.name.trim();
  return {
    name,
    initials:
      input.initials?.trim() ||
      name
        .split(/\s+/)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase(),
    color: input.color?.trim() || "#6366f1",
    login: input.login.trim(),
  };
}

export function registerMemberRoutes(app: FastifyInstance, ctx: BackendContext) {
  app.get("/api/members", async () => ({ members: await ctx.db.select().from(members) }));

  app.post("/api/members", async (request, reply) => {
    try {
      const [member] = await ctx.db
        .insert(members)
        .values({ id: crypto.randomUUID(), ...parseMemberInput(request.body) })
        .returning();
      return reply.code(201).send({ member });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/api/members/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [existing] = await ctx.db.select().from(members).where(eq(members.id, id));
    if (!existing) return reply.code(404).send({ error: `Unknown member: ${id}` });
    try {
      const [member] = await ctx.db
        .update(members)
        .set(parseMemberInput(request.body))
        .where(eq(members.id, id))
        .returning();
      return { member };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/members/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [existing] = await ctx.db.select().from(members).where(eq(members.id, id));
    if (!existing) return reply.code(404).send({ error: `Unknown member: ${id}` });
    await ctx.db.delete(members).where(eq(members.id, id));
    return { status: "success" };
  });
}
