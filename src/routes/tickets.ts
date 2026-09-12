import { connectorStatus, workItems } from "@chienkq/workflow-db";
import { and, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";
import { parseJiraExcelImport } from "../integrations/jira/jiraExcelImport.js";
import {
  convertNamesToPlanningGroups,
  convertTicketsToWorkItems,
  previewTicketConversions,
} from "../integrations/jira/jiraTicketToWorkItem.js";

export function registerTicketRoutes(app: FastifyInstance, ctx: BackendContext) {
  // Jira Excel import — an alternative to the live `/rest/api/3/search` sync (W1) for teams that export
  // their Jira board to Excel instead of granting API access, surfaced from the Work Items screen. Rows
  // are normalized to the same shape as the live sync and upserted into `tickets` keyed by issue
  // key, so a re-import or a later live sync of the same issues updates the existing row rather than
  // duplicating it. Parsing + upserting a real export runs in the background (see integrations/jira/jiraImportJobs.ts) —
  // this route only reads the upload and returns a job id; the client polls the route below for status.
  app.post("/api/tickets/import-excel", async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "No file uploaded." });

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      return reply.code(400).send({ error: "The uploaded file is too large or could not be read." });
    }

    const job = ctx.jiraImportJobs.create();
    setImmediate(async () => {
      try {
        const { tickets, skipped } = parseJiraExcelImport(buffer);
        await ctx.services.ticketStore.upsertTickets(tickets);
        await ctx.db
          .insert(connectorStatus)
          .values({ provider: "jira", lastSyncAt: new Date(), lastSuccess: true, lastError: null })
          .onConflictDoUpdate({
            target: connectorStatus.provider,
            set: { lastSyncAt: new Date(), lastSuccess: true, lastError: null },
          });
        ctx.jiraImportJobs.complete(job.id, { imported: tickets.length, skipped });
      } catch (error) {
        ctx.jiraImportJobs.fail(job.id, error instanceof Error ? error.message : String(error));
      }
    });

    return reply.code(202).send(job);
  });

  app.get("/api/tickets/import-excel/:jobId", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = ctx.jiraImportJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: "Unknown import job." });
    return job;
  });

  // Backs the Jira data view on the Work Items screen — tickets written by both the live sync (W1) and the
  // Excel import above, merged by issue key.
  app.get("/api/tickets", async (request) => {
    const { provider, projectKey, status, priority, assignee } = request.query as Record<string, string | undefined>;
    const items = await ctx.services.ticketStore.queryTickets({ provider, projectKey, status, priority, assignee });
    if (items.length === 0) return { items };

    // Tags each ticket with the work item it was already converted to (if any), matched the same way
    // convertTicketsToWorkItems() matches — on (externalProvider, externalKey) — so the "Jira data" table
    // can show a Converted/Not converted status instead of the user having to guess and re-click Convert.
    const converted = await ctx.db
      .select({ id: workItems.id, provider: workItems.externalProvider, key: workItems.externalKey })
      .from(workItems)
      .where(
        and(
          inArray(
            workItems.externalKey,
            items.map((item) => item.externalKey),
          ),
          inArray(workItems.externalProvider, [...new Set(items.map((item) => item.provider))]),
        ),
      );
    const convertedByKey = new Map(converted.map((row) => [`${row.provider}|${row.key}`, row.id]));

    return {
      items: items.map((item) => ({
        ...item,
        convertedWorkItemId: convertedByKey.get(`${item.provider}|${item.externalKey}`),
      })),
    };
  });

  // Read-only "what would happen" preview ahead of the real convert below — the Jira Sync screen's
  // "Preview changes" button, so a silent overwrite (conversion always replaces description/labels/
  // cycle/module/due date/story points, only title/status/priority go through a three-way merge) is
  // visible before it happens, not just after.
  app.post("/api/tickets/convert-to-work-items/preview", async (request, reply) => {
    const { ids } = (request.body as { ids?: string[] } | undefined) ?? {};
    if (!ids || ids.length === 0) return reply.code(400).send({ error: "Body must include a non-empty `ids` array." });

    const allTickets = await ctx.services.ticketStore.queryTickets({});
    const idSet = new Set(ids);
    const tickets = allTickets.filter((ticket) => idSet.has(ticket.id));
    if (tickets.length === 0) return reply.code(404).send({ error: "No matching tickets found." });

    const previews = await previewTicketConversions(ctx.db, tickets);
    return { previews };
  });

  // Converting a Jira ticket into a real platform work item is a deliberate, user-picked action (not
  // automatic on import/sync) — the Jira data dialog lets the user select which rows to convert. Matched
  // on (provider, externalKey) via integrations/jira/jiraTicketToWorkItem.ts, so re-converting an already-converted ticket
  // updates its work item rather than duplicating it.
  app.post("/api/tickets/convert-to-work-items", async (request, reply) => {
    const { ids, projectId } = (request.body as { ids?: string[]; projectId?: string } | undefined) ?? {};
    if (!ids || ids.length === 0) return reply.code(400).send({ error: "Body must include a non-empty `ids` array." });

    const allTickets = await ctx.services.ticketStore.queryTickets({});
    const idSet = new Set(ids);
    const tickets = allTickets.filter((ticket) => idSet.has(ticket.id));
    if (tickets.length === 0) return reply.code(404).send({ error: "No matching tickets found." });

    const { created, updated } = await convertTicketsToWorkItems(ctx.db, tickets, projectId);
    return { status: "success", created, updated };
  });

  // The Jira Sync screen's "Sprints" and "Modules" sections — a deliberate, reviewable pre-step ahead of
  // converting work items: turns the distinct Sprint (or Fix Version/s) values found across the imported
  // tickets straight into cycles (or modules) in `projectId`, so a messy/duplicate Jira name can be
  // caught and fixed before it lands as a cycle/module, rather than only ever being created silently as a
  // side effect of "Convert to work items" (which still happens too, as a fallback — see
  // integrations/jira/jiraTicketToWorkItem.ts's `mapTicketToPlanningGroups`).
  app.post("/api/tickets/convert-to-cycles", async (request, reply) => {
    const { names, projectId } = (request.body as { names?: string[]; projectId?: string } | undefined) ?? {};
    if (!names || names.length === 0) return reply.code(400).send({ error: "Body must include a non-empty `names` array." });
    if (!projectId) return reply.code(400).send({ error: "Body must include `projectId`." });

    const result = await convertNamesToPlanningGroups(ctx.db, projectId, "cycle", names);
    return { status: "success", ...result };
  });

  app.post("/api/tickets/convert-to-modules", async (request, reply) => {
    const { names, projectId } = (request.body as { names?: string[]; projectId?: string } | undefined) ?? {};
    if (!names || names.length === 0) return reply.code(400).send({ error: "Body must include a non-empty `names` array." });
    if (!projectId) return reply.code(400).send({ error: "Body must include `projectId`." });

    const result = await convertNamesToPlanningGroups(ctx.db, projectId, "module", names);
    return { status: "success", ...result };
  });

  // Left behind by the three-way merge in convertTicketsToWorkItems() above when both the app and Jira
  // changed the same field since the last sync — surfaced on the Jira Sync screen's "Resolve sync
  // conflicts" card, never auto-resolved.
  app.get("/api/tickets/conflicts", async (request, reply) => {
    const { projectId } = request.query as Record<string, string | undefined>;
    if (!projectId) return reply.code(400).send({ error: "Query must include `projectId`." });
    const conflicts = await ctx.ticketSyncConflictStore.listByProject(projectId);
    return { conflicts };
  });

  app.post("/api/tickets/conflicts/:id/resolve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { choice } = (request.body as { choice?: "app" | "jira" } | undefined) ?? {};
    if (choice !== "app" && choice !== "jira") return reply.code(400).send({ error: 'Body must include `choice` of "app" or "jira".' });
    try {
      await ctx.ticketSyncConflictStore.resolve(id, choice);
      return { status: "success" };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
