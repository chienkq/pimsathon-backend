import type { TicketStoreService, NormalizedTicket, StoredTicket, TicketFilter } from "@chienkq/workflow-core";
import { tickets, type WorkflowDb } from "@chienkq/workflow-db";
import { and, eq, sql } from "drizzle-orm";

const FILTER_COLUMNS = {
  provider: tickets.provider,
  projectKey: tickets.projectKey,
  status: tickets.status,
  priority: tickets.priority,
  assignee: tickets.assignee,
} as const;

/** Real Postgres-backed implementation of `services.ticketStore` for the `ticketUpsert` node. */
export function createTicketStore(db: WorkflowDb): TicketStoreService {
  return {
    async upsertTickets(items: NormalizedTicket[]) {
      if (items.length === 0) return;
      await Promise.all(
        items.map((item) =>
          db
            .insert(tickets)
            .values({ id: crypto.randomUUID(), ...item, syncedAt: new Date() })
            .onConflictDoUpdate({
              target: [tickets.provider, tickets.externalId],
              set: {
                externalKey: item.externalKey,
                projectKey: item.projectKey,
                title: item.title,
                status: item.status,
                priority: item.priority,
                assignee: item.assignee,
                storyPoints: item.storyPoints,
                sprintId: item.sprintId,
                issueType: item.issueType,
                epicKey: item.epicKey,
                epicName: item.epicName,
                components: item.components,
                fixVersions: item.fixVersions,
                labels: item.labels,
                dueDate: item.dueDate,
                raw: item.raw,
                syncedAt: sql`now()`,
              },
            }),
        ),
      );
    },

    async queryTickets(filter: TicketFilter): Promise<StoredTicket[]> {
      const conditions = (Object.entries(filter) as [keyof TicketFilter, string | undefined][])
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => eq(FILTER_COLUMNS[key], value as string));

      const rows = await db
        .select()
        .from(tickets)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      return rows.map((row) => ({
        ...row,
        priority: row.priority ?? undefined,
        assignee: row.assignee ?? undefined,
        storyPoints: row.storyPoints ?? undefined,
        sprintId: row.sprintId ?? undefined,
        issueType: row.issueType ?? undefined,
        epicKey: row.epicKey ?? undefined,
        epicName: row.epicName ?? undefined,
        components: row.components ?? undefined,
        fixVersions: row.fixVersions ?? undefined,
        labels: row.labels ?? undefined,
        dueDate: row.dueDate ?? undefined,
        syncedAt: row.syncedAt.toISOString(),
      }));
    },
  };
}
