import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CredentialStore } from "./credentialStore.js";

const execFileAsync = promisify(execFile);

export interface LocalGitFileSnippet {
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

/** Resolves `filePath` against `repoPath` and rejects anything that escapes the repo folder (e.g. `../../etc/passwd`). */
function resolveWithinRepo(repoPath: string, filePath: string): string {
  const repoRoot = path.resolve(repoPath);
  const resolved = path.resolve(repoRoot, filePath);
  if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(`"${filePath}" is outside the configured repository folder.`);
  }
  return resolved;
}

/** Plain client over a local folder — the `local-git` integration's read side, standing in for a
 *  real GitHub connection so work items can reference local code/branches without one. Read-only:
 *  no PRs/issues, no writes — just file content and branch names read straight from the checkout. */
export function createLocalGitClient(config: { repoPath: string }) {
  return {
    async getFileSnippet(filePath: string, startLine?: number, endLine?: number): Promise<LocalGitFileSnippet> {
      const resolved = resolveWithinRepo(config.repoPath, filePath);
      const raw = await fs.readFile(resolved, "utf-8");
      const lines = raw.split("\n");
      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(lines.length, endLine ?? lines.length);
      if (start > end) throw new Error(`Invalid line range: ${start}-${end}.`);
      return {
        filePath,
        startLine: start,
        endLine: end,
        totalLines: lines.length,
        content: lines.slice(start - 1, end).join("\n"),
      };
    },

    /** Local branch names (`git branch --format`), optionally filtered to those containing `query`
     *  (case-insensitive) — used to surface branches matching a work item's key (e.g. "PROJ-12"). */
    async listBranches(query?: string): Promise<string[]> {
      const { stdout } = await execFileAsync("git", ["-C", config.repoPath, "branch", "-a", "--format=%(refname:short)"]);
      const names = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((name) => name !== "origin/HEAD" && !name.endsWith("/HEAD"));
      const unique = Array.from(new Set(names));
      if (!query) return unique;
      const needle = query.toLowerCase();
      return unique.filter((name) => name.toLowerCase().includes(needle));
    },
  };
}

export type LocalGitClient = ReturnType<typeof createLocalGitClient>;

/** Reads `repoPath` from the credentials table on every call, same pattern as the other
 *  `createXClientFromCredentials` wrappers, so reconfiguring in Settings → Integrations takes effect
 *  immediately. */
export function createLocalGitClientFromCredentials(credentialStore: CredentialStore): LocalGitClient {
  async function requireClient() {
    const config = await credentialStore.getConfig("local-git");
    if (!config?.repoPath) {
      throw new Error("Local Git Folder is not connected. Configure it in Settings → Git Control.");
    }
    return createLocalGitClient({ repoPath: config.repoPath });
  }
  return {
    async getFileSnippet(filePath: string, startLine?: number, endLine?: number) {
      return (await requireClient()).getFileSnippet(filePath, startLine, endLine);
    },
    async listBranches(query?: string) {
      return (await requireClient()).listBranches(query);
    },
  };
}

/** Test-connection check used by `/api/integrations/local-git/test` — confirms the configured path
 *  exists, is a directory, and looks like a git checkout. */
export async function testLocalGitConnection(repoPath: string): Promise<{ ok: boolean; detail?: string }> {
  const stat = await fs.stat(repoPath).catch(() => undefined);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`"${repoPath}" is not a directory the backend can read.`);
  }
  const hasGitDir = await fs
    .stat(path.join(repoPath, ".git"))
    .then((s) => s.isDirectory())
    .catch(() => false);
  return { ok: true, detail: hasGitDir ? repoPath : `${repoPath} (no .git folder found — not a git checkout)` };
}
