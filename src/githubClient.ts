import type { GitBranch, GitClientService, GitCommit, GitIssue, GitPullRequest } from "@chienkq/workflow-core";
import type { CredentialStore } from "./credentialStore.js";

interface GitHubApiError {
  message?: string;
}

/** Real GitHub REST API v3 client — the `services.gitClient` implementation for the `git` node. */
export function createGitClient(config: { token: string }): GitClientService {
  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as GitHubApiError;
      throw new Error(`GitHub API ${init?.method ?? "GET"} ${path} failed: ${response.status} ${body.message ?? response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  return {
    async getRepository(owner, repo) {
      const data = await api<{ default_branch: string }>(`/repos/${owner}/${repo}`);
      return { defaultBranch: data.default_branch };
    },

    async listBranches(owner, repo): Promise<GitBranch[]> {
      const data = await api<{ name: string; commit: { sha: string } }[]>(`/repos/${owner}/${repo}/branches?per_page=50`);
      return data.map((b) => ({ name: b.name, sha: b.commit.sha }));
    },

    async listCommits(owner, repo, branch): Promise<GitCommit[]> {
      const data = await api<
        { sha: string; commit: { message: string; author: { date: string } }; author: { login: string } | null }[]
      >(`/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=30`);
      return data.map((c) => ({ sha: c.sha, message: c.commit.message, authorLogin: c.author?.login ?? "", at: c.commit.author.date }));
    },

    async listPullRequests(owner, repo, state): Promise<GitPullRequest[]> {
      const data = await api<
        { number: number; title: string; head: { ref: string }; base: { ref: string }; state: "open" | "closed"; merged_at: string | null; html_url: string }[]
      >(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=30`);
      return data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        status: pr.merged_at ? "Merged" : pr.state === "open" ? "Open" : "Closed",
        url: pr.html_url,
      }));
    },

    async listIssues(owner, repo, state): Promise<GitIssue[]> {
      const data = await api<
        {
          number: number;
          title: string;
          body: string | null;
          labels: (string | { name: string })[];
          assignee: { login: string } | null;
          state: "open" | "closed";
          html_url: string;
          pull_request?: unknown;
        }[]
      >(`/repos/${owner}/${repo}/issues?state=${state}&per_page=30`);
      // GitHub's issues endpoint also returns PRs — a real issue never has a `pull_request` key.
      return data
        .filter((issue) => !issue.pull_request)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          description: issue.body ?? "",
          labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
          assignee: issue.assignee?.login ?? "",
          state: issue.state,
          url: issue.html_url,
        }));
    },

    async createIssue(owner, repo, input): Promise<GitIssue> {
      const data = await api<{ number: number; title: string; body: string | null; labels: { name: string }[]; assignee: { login: string } | null; state: "open" | "closed"; html_url: string }>(
        `/repos/${owner}/${repo}/issues`,
        {
          method: "POST",
          body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels, assignees: input.assignee ? [input.assignee] : [] }),
        },
      );
      return {
        number: data.number,
        title: data.title,
        description: data.body ?? "",
        labels: data.labels.map((l) => l.name),
        assignee: data.assignee?.login ?? "",
        state: data.state,
        url: data.html_url,
      };
    },

    async createBranch(owner, repo, input): Promise<GitBranch> {
      const ref = await api<{ object: { sha: string } }>(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(input.fromBranch)}`);
      await api(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${input.name}`, sha: ref.object.sha }),
      });
      return { name: input.name, sha: ref.object.sha };
    },

    async createPullRequest(owner, repo, input): Promise<GitPullRequest> {
      const data = await api<{ number: number; title: string; head: { ref: string }; base: { ref: string }; state: "open" | "closed"; html_url: string }>(
        `/repos/${owner}/${repo}/pulls`,
        { method: "POST", body: JSON.stringify({ title: input.title, head: input.head, base: input.base }) },
      );
      return { number: data.number, title: data.title, headBranch: data.head.ref, baseBranch: data.base.ref, status: "Open", url: data.html_url };
    },
  };
}

export interface GitHubAccountRepo {
  owner: string;
  name: string;
  defaultBranch: string;
}

/** Lists every repo the token's account can see (`GET /user/repos`) — used to populate a
 *  "connect a repository" picker with the account's real repos, not just the single owner/repo
 *  pinned in the GitHub credential config. */
export async function listAccountRepositories(token: string): Promise<GitHubAccountRepo[]> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const repos: GitHubAccountRepo[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(`https://api.github.com/user/repos?per_page=100&page=${page}&sort=full_name`, {
      headers,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as GitHubApiError;
      throw new Error(`GitHub API GET /user/repos failed: ${response.status} ${body.message ?? response.statusText}`);
    }
    const data = (await response.json()) as { owner: { login: string }; name: string; default_branch: string }[];
    repos.push(...data.map((r) => ({ owner: r.owner.login, name: r.name, defaultBranch: r.default_branch })));
    if (data.length < 100) break;
  }
  return repos;
}

/**
 * `GitClientService` backed by the Integrations screen's stored credential (`credentials` table,
 * provider `github`) instead of a fixed token — looked up fresh on every call so a reconfigure in
 * Settings takes effect on the next scheduled sync without a backend restart. Throws a message aimed
 * at the end user (surfaced via `runWorkflow`'s `connector_status` write) when nothing is configured
 * yet, so the Integrations card and any UI reading `connector_status` show the same "not connected"
 * state.
 */
export function createGitClientFromCredentials(credentialStore: CredentialStore): GitClientService {
  async function client(): Promise<GitClientService> {
    const config = await credentialStore.getConfig("github");
    if (!config?.token) throw new Error("GitHub is not connected. Configure it in Settings → Integrations.");
    return createGitClient({ token: config.token });
  }

  return {
    getRepository: async (owner, repo) => (await client()).getRepository(owner, repo),
    listBranches: async (owner, repo) => (await client()).listBranches(owner, repo),
    listCommits: async (owner, repo, branch) => (await client()).listCommits(owner, repo, branch),
    listPullRequests: async (owner, repo, state) => (await client()).listPullRequests(owner, repo, state),
    listIssues: async (owner, repo, state) => (await client()).listIssues(owner, repo, state),
    createIssue: async (owner, repo, input) => (await client()).createIssue(owner, repo, input),
    createBranch: async (owner, repo, input) => (await client()).createBranch(owner, repo, input),
    createPullRequest: async (owner, repo, input) => (await client()).createPullRequest(owner, repo, input),
  };
}
