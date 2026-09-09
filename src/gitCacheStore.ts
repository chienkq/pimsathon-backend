import type { GitBranch, GitCacheStoreService, GitIssue, GitPullRequest, GitRepositoryInfo } from "@chienkq/workflow-core";
import { branches, githubIssues, pullRequests, repositories, type WorkflowDb } from "@chienkq/workflow-db";
import { and, eq } from "drizzle-orm";

/** Real Postgres-backed implementation of `services.gitCacheStore` for the `gitCacheUpsert` node. */
export function createGitCacheStore(db: WorkflowDb): GitCacheStoreService {
  async function ensureRepository(owner: string, repo: string): Promise<string> {
    const [existing] = await db.select({ id: repositories.id }).from(repositories).where(and(eq(repositories.owner, owner), eq(repositories.name, repo)));
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    await db.insert(repositories).values({ id, owner, name: repo });
    return id;
  }

  return {
    async upsertRepository(owner, repo, info: GitRepositoryInfo) {
      const [existing] = await db.select({ id: repositories.id }).from(repositories).where(and(eq(repositories.owner, owner), eq(repositories.name, repo)));
      if (existing) {
        await db.update(repositories).set({ defaultBranch: info.defaultBranch }).where(eq(repositories.id, existing.id));
      } else {
        await db.insert(repositories).values({ id: crypto.randomUUID(), owner, name: repo, defaultBranch: info.defaultBranch });
      }
    },

    async upsertBranches(owner, repo, list: GitBranch[]) {
      if (list.length === 0) return;
      const repositoryId = await ensureRepository(owner, repo);
      await Promise.all(
        list.map((b) =>
          db
            .insert(branches)
            .values({ id: crypto.randomUUID(), repositoryId, name: b.name, sha: b.sha })
            .onConflictDoUpdate({ target: [branches.repositoryId, branches.name], set: { sha: b.sha, syncedAt: new Date() } }),
        ),
      );
    },

    async upsertPullRequests(owner, repo, list: GitPullRequest[]) {
      if (list.length === 0) return;
      const repositoryId = await ensureRepository(owner, repo);
      await Promise.all(
        list.map((pr) =>
          db
            .insert(pullRequests)
            .values({
              id: crypto.randomUUID(),
              repositoryId,
              number: pr.number,
              headBranch: pr.headBranch,
              baseBranch: pr.baseBranch,
              title: pr.title,
              status: pr.status,
              url: pr.url,
            })
            .onConflictDoUpdate({
              target: [pullRequests.repositoryId, pullRequests.number],
              set: { headBranch: pr.headBranch, baseBranch: pr.baseBranch, title: pr.title, status: pr.status, url: pr.url, syncedAt: new Date() },
            }),
        ),
      );
    },

    async upsertIssues(owner, repo, list: GitIssue[]) {
      if (list.length === 0) return;
      const repositoryId = await ensureRepository(owner, repo);
      await Promise.all(
        list.map((issue) =>
          db
            .insert(githubIssues)
            .values({
              id: crypto.randomUUID(),
              repositoryId,
              number: issue.number,
              title: issue.title,
              description: issue.description,
              labels: issue.labels,
              assignee: issue.assignee,
              state: issue.state,
              url: issue.url,
            })
            .onConflictDoUpdate({
              target: [githubIssues.repositoryId, githubIssues.number],
              set: {
                title: issue.title,
                description: issue.description,
                labels: issue.labels,
                assignee: issue.assignee,
                state: issue.state,
                url: issue.url,
                syncedAt: new Date(),
              },
            }),
        ),
      );
    },
  };
}
