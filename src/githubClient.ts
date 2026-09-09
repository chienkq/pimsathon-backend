import type { GitBranch, GitClientService, GitCommit, GitIssue, GitPullRequest } from "@chienkq/workflow-core";

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
