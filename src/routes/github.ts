import { branches, githubIssues, issueLinks, pullRequests, repositories } from "@chienkq/workflow-db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { BackendContext } from "../app.js";
import { listAccountRepositories } from "../integrations/github/githubClient.js";

// Real GitHub data, synced by W3 (GitHub Sync) into Postgres. Branch/PR creation now writes
// through to the real GitHub API too (see the POST routes below); Issue create/edit still isn't.
export function registerGithubRoutes(app: FastifyInstance, ctx: BackendContext) {
  app.get("/api/repositories", async () => ({ repositories: await ctx.db.select().from(repositories) }));

  // Live list of every repo the connected GitHub account can see (not just the single owner/repo
  // pinned in the credential config for W3) — upserts each into `repositories` so it gets a stable
  // `id` and can then go through the normal `/connect` route below like any other known repo.
  app.get("/api/repositories/github", async (request, reply) => {
    const config = await ctx.credentialStore.getConfig("github");
    if (!config?.token)
      return reply.code(400).send({ error: "GitHub is not connected. Configure it in Settings → Integrations." });
    let accountRepos: Awaited<ReturnType<typeof listAccountRepositories>>;
    try {
      accountRepos = await listAccountRepositories(config.token);
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Failed to list GitHub repositories." });
    }
    await Promise.all(
      accountRepos.map((r) => ctx.services.gitCacheStore.upsertRepository(r.owner, r.name, { defaultBranch: r.defaultBranch }))
    );
    return { repositories: await ctx.db.select().from(repositories) };
  });

  // Manual, on-demand pull of branches/PRs/Issues straight from GitHub into the cache tables — the
  // "reload" icon in WorkItemGit.tsx, so a branch/PR/Issue created directly on GitHub shows up for
  // linking without waiting for the 15-min GitHub Sync cron (see seeds/seedWorkflow.ts's buildGitHubSyncWorkflow).
  app.post("/api/repositories/:id/sync", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [repo] = await ctx.db.select().from(repositories).where(eq(repositories.id, id));
    if (!repo) return reply.code(404).send({ error: `Unknown repository: ${id}` });
    try {
      const [branchList, pullRequestList, issueList] = await Promise.all([
        ctx.services.gitClient.listBranches(repo.owner, repo.name),
        ctx.services.gitClient.listPullRequests(repo.owner, repo.name, "all"),
        ctx.services.gitClient.listIssues(repo.owner, repo.name, "all"),
      ]);
      await Promise.all([
        ctx.services.gitCacheStore.upsertBranches(repo.owner, repo.name, branchList),
        ctx.services.gitCacheStore.upsertPullRequests(repo.owner, repo.name, pullRequestList),
        ctx.services.gitCacheStore.upsertIssues(repo.owner, repo.name, issueList),
      ]);
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Failed to sync from GitHub." });
    }
    return { status: "success" };
  });

  app.get("/api/repositories/:id/branches", async (request) => {
    const { id } = request.params as { id: string };
    return { branches: await ctx.db.select().from(branches).where(eq(branches.repositoryId, id)) };
  });

  app.get("/api/repositories/:id/pull-requests", async (request) => {
    const { id } = request.params as { id: string };
    return { pullRequests: await ctx.db.select().from(pullRequests).where(eq(pullRequests.repositoryId, id)) };
  });

  // Creates a real branch on GitHub (from the repo's default branch) and mirrors it into the cache
  // table so it shows up immediately via the GET route above — see WorkItemGit.tsx's "Branches" section.
  app.post("/api/repositories/:id/branches", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { name, workItemId } = request.body as { name?: string; workItemId?: string | null };
    if (!name?.trim()) return reply.code(400).send({ error: "Body must include `name`." });
    const [repo] = await ctx.db.select().from(repositories).where(eq(repositories.id, id));
    if (!repo) return reply.code(404).send({ error: `Unknown repository: ${id}` });
    let created: Awaited<ReturnType<typeof ctx.services.gitClient.createBranch>>;
    try {
      created = await ctx.services.gitClient.createBranch(repo.owner, repo.name, { name: name.trim(), fromBranch: repo.defaultBranch });
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Failed to create branch on GitHub." });
    }
    const [branch] = await ctx.db
      .insert(branches)
      .values({ id: crypto.randomUUID(), repositoryId: id, name: created.name, sha: created.sha, workItemId: workItemId ?? null })
      .onConflictDoUpdate({
        target: [branches.repositoryId, branches.name],
        set: { sha: created.sha, workItemId: workItemId ?? null, syncedAt: new Date() },
      })
      .returning();
    return { branch };
  });

  // Links an already-cached branch (created directly on GitHub, or synced before it had a work item)
  // to a work item — the "select an existing branch" flow in WorkItemGit.tsx, mirroring /api/issue-links.
  app.patch("/api/branches/:id/link", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { workItemId } = request.body as { workItemId?: string | null };
    if (workItemId === undefined) return reply.code(400).send({ error: "Body must include `workItemId` (string or null)." });
    const [branch] = await ctx.db.update(branches).set({ workItemId }).where(eq(branches.id, id)).returning();
    if (!branch) return reply.code(404).send({ error: `Unknown branch: ${id}` });
    return { branch };
  });

  // Creates a real pull request on GitHub and mirrors it into the cache table — see WorkItemGit.tsx's
  // "Pull requests" section.
  app.post("/api/repositories/:id/pull-requests", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { headBranch, title, workItemId } = request.body as { headBranch?: string; title?: string; workItemId?: string | null };
    if (!headBranch?.trim() || !title?.trim())
      return reply.code(400).send({ error: "Body must include `headBranch` and `title`." });
    const [repo] = await ctx.db.select().from(repositories).where(eq(repositories.id, id));
    if (!repo) return reply.code(404).send({ error: `Unknown repository: ${id}` });
    let created: Awaited<ReturnType<typeof ctx.services.gitClient.createPullRequest>>;
    try {
      created = await ctx.services.gitClient.createPullRequest(repo.owner, repo.name, {
        title: title.trim(),
        head: headBranch.trim(),
        base: repo.defaultBranch,
      });
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Failed to open pull request on GitHub." });
    }
    const [pullRequest] = await ctx.db
      .insert(pullRequests)
      .values({
        id: crypto.randomUUID(),
        repositoryId: id,
        number: created.number,
        headBranch: created.headBranch,
        baseBranch: created.baseBranch,
        title: created.title,
        status: created.status,
        url: created.url,
        workItemId: workItemId ?? null,
      })
      .onConflictDoUpdate({
        target: [pullRequests.repositoryId, pullRequests.number],
        set: {
          headBranch: created.headBranch,
          baseBranch: created.baseBranch,
          title: created.title,
          status: created.status,
          url: created.url,
          workItemId: workItemId ?? null,
          syncedAt: new Date(),
        },
      })
      .returning();
    return { pullRequest };
  });

  // Links an already-cached pull request (opened directly on GitHub, or synced before it had a work
  // item) to a work item — the "select an existing PR" flow in WorkItemGit.tsx, mirroring /api/issue-links.
  app.patch("/api/pull-requests/:id/link", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { workItemId } = request.body as { workItemId?: string | null };
    if (workItemId === undefined) return reply.code(400).send({ error: "Body must include `workItemId` (string or null)." });
    const [pullRequest] = await ctx.db.update(pullRequests).set({ workItemId }).where(eq(pullRequests.id, id)).returning();
    if (!pullRequest) return reply.code(404).send({ error: `Unknown pull request: ${id}` });
    return { pullRequest };
  });

  app.get("/api/repositories/:id/issues", async (request) => {
    const { id } = request.params as { id: string };
    return { issues: await ctx.db.select().from(githubIssues).where(eq(githubIssues.repositoryId, id)) };
  });

  // Work item <-> GitHub Issue links (admin-ui's own bookkeeping, not a GitHub concept) — persisted
  // here so a link survives a reload instead of living only in admin-ui's in-memory local state.
  app.get("/api/issue-links", async () => ({ issueLinks: await ctx.db.select().from(issueLinks) }));

  app.post("/api/issue-links", async (request, reply) => {
    const { workItemId, issueId, base } = request.body as {
      workItemId?: string;
      issueId?: string;
      base?: { title: string; description: string; labels: string[]; assignee: string; state: "open" | "closed" };
    };
    if (!workItemId || !issueId || !base)
      return reply.code(400).send({ error: "Body must include `workItemId`, `issueId` and `base`." });
    try {
      const [link] = await ctx.db.insert(issueLinks).values({ id: crypto.randomUUID(), workItemId, issueId, base }).returning();
      return { issueLink: link };
    } catch {
      return reply.code(409).send({ error: "This work item or Issue is already linked." });
    }
  });
}
