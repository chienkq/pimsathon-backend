import { getIntegrationProvider, INTEGRATION_PROVIDERS, type IntegrationProviderId } from "@chienkq/workflow-core";
import { connectorStatus } from "@chienkq/workflow-db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";
import { testLocalGitConnection } from "../integrations/localGit/localGitClient.js";
import { createGmailClient } from "../integrations/gmail/gmailClient.js";
import { createOutlookClient } from "../integrations/outlook/outlookClient.js";
import { createSlackClient } from "../integrations/slack/slackClient.js";
import { createTeamsClient } from "../integrations/teams/teamsClient.js";

async function testIntegration(
  ctx: BackendContext,
  provider: IntegrationProviderId
): Promise<{ ok: boolean; detail?: string }> {
  const config = await ctx.credentialStore.getConfig(provider);
  if (!config) throw new Error(`${provider} is not configured yet.`);

  switch (provider) {
    case "jira": {
      const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
      const response = await fetch(`${config.baseUrl}/rest/api/3/myself`, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Jira auth check failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { displayName?: string };
      return { ok: true, detail: data.displayName };
    }
    case "github": {
      const response = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${config.token}`, Accept: "application/vnd.github+json" },
      });
      if (!response.ok) throw new Error(`GitHub auth check failed: ${response.status} ${response.statusText}`);
      const data = (await response.json()) as { login?: string };
      return { ok: true, detail: data.login };
    }
    case "slack":
      return createSlackClient({ botToken: config.botToken }).testConnection();
    case "teams":
      return createTeamsClient({ webhookUrl: config.webhookUrl }).testConnection();
    case "outlook":
      return createOutlookClient({
        tenantId: config.tenantId,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        senderUpn: config.senderUpn,
      }).testConnection();
    case "gmail":
      return createGmailClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: config.refreshToken,
        fromEmail: config.fromEmail,
      }).testConnection();
    case "local-git":
      return testLocalGitConnection(config.repoPath);
  }
}

// Integrations screen (W6) — connect/configure Jira, GitHub, Slack, Teams, Outlook, Gmail. Secrets
// are AES-256-GCM encrypted at rest (store/credentialStore.ts) and NEVER echoed back to the client; the
// list route only reports which config keys are currently set.
export function registerIntegrationRoutes(app: FastifyInstance, ctx: BackendContext) {
  app.get("/api/integrations", async () => {
    const configured = await ctx.credentialStore.listConfiguredProviders();
    const statusRows = await ctx.db.select().from(connectorStatus);
    const statusByProvider = new Map(statusRows.map((row) => [row.provider, row]));
    return {
      integrations: INTEGRATION_PROVIDERS.map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        description: provider.description,
        color: provider.color,
        fields: provider.fields.map(({ key, label, type, placeholder, helpText }) => ({
          key,
          label,
          type,
          placeholder,
          helpText,
        })),
        category: provider.category,
        connected: configured.has(provider.id),
        status: statusByProvider.get(provider.id) ?? null,
      })),
    };
  });

  app.put("/api/integrations/:provider", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const spec = getIntegrationProvider(provider);
    if (!spec) return reply.code(404).send({ error: `Unknown integration provider: ${provider}` });

    const { config } = (request.body as { config?: Record<string, string> } | undefined) ?? {};
    if (!config) return reply.code(400).send({ error: "Body must include `config`." });
    const missing = spec.fields.filter((field) => !config[field.key]).map((field) => field.key);
    if (missing.length > 0) return reply.code(400).send({ error: `Missing required field(s): ${missing.join(", ")}` });

    const trimmed = Object.fromEntries(spec.fields.map((field) => [field.key, config[field.key]]));
    await ctx.credentialStore.setConfig(spec.id, trimmed);
    return { status: "success" };
  });

  app.delete("/api/integrations/:provider", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const spec = getIntegrationProvider(provider);
    if (!spec) return reply.code(404).send({ error: `Unknown integration provider: ${provider}` });
    await ctx.credentialStore.remove(spec.id);
    await ctx.db.delete(connectorStatus).where(eq(connectorStatus.provider, spec.id));
    return { status: "success" };
  });

  app.post("/api/integrations/:provider/test", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const spec = getIntegrationProvider(provider);
    if (!spec) return reply.code(404).send({ error: `Unknown integration provider: ${provider}` });

    try {
      const result = await testIntegration(ctx, spec.id);
      await ctx.db
        .insert(connectorStatus)
        .values({ provider: spec.id, lastSyncAt: new Date(), lastSuccess: true, lastError: null })
        .onConflictDoUpdate({
          target: connectorStatus.provider,
          set: { lastSyncAt: new Date(), lastSuccess: true, lastError: null },
        });
      return { status: "success", ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.db
        .insert(connectorStatus)
        .values({ provider: spec.id, lastSyncAt: new Date(), lastSuccess: false, lastError: message })
        .onConflictDoUpdate({
          target: connectorStatus.provider,
          set: { lastSyncAt: new Date(), lastSuccess: false, lastError: message },
        });
      return reply.code(502).send({ status: "error", error: message });
    }
  });
}
