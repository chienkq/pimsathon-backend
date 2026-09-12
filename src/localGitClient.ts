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

export interface LocalGitStatus {
  currentBranch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  notAdded: string[];
  deleted: string[];
  conflicted: string[];
  isClean: boolean;
}

export interface LocalGitLogEntry {
  hash: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
}

export interface LocalGitConfigEntry {
  key: string;
  value: string;
}

export interface LocalGitProjectFile {
  path: string;
  content: string;
  bytes: number;
}

export interface LocalGitProjectFiles {
  files: LocalGitProjectFile[];
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
}

export interface LocalGitSearchMatch {
  path: string;
  line: number;
  text: string;
}

/** Extensions never worth reading as text — binary/generated, would just burn the size budget. */
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".svg",
  ".pdf", ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".gz", ".tar", ".7z", ".rar",
  ".mp4", ".mp3", ".wav", ".mov", ".avi",
  ".wasm", ".node", ".exe", ".dll", ".so", ".dylib",
]);
/** Exact filenames skipped regardless of extension — huge, machine-generated, not source code. */
const SKIP_FILENAMES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);
/** Any single file over this size is skipped outright rather than eating the whole total-size budget. */
const MAX_SINGLE_FILE_BYTES = 100_000;
/** Safety cap on how many tracked paths `git ls-files` results are even considered, before size filtering. */
const MAX_CANDIDATE_FILES = 5_000;

/** Parses `git status --porcelain=v1 -b` output — first line is the branch/tracking header
 *  (e.g. "## main...origin/main [ahead 1, behind 2]"), remaining lines are two-letter XY status
 *  codes per path (see git-status(1) short format). */
function parseStatusPorcelain(stdout: string): LocalGitStatus {
  const lines = stdout.split("\n").filter(Boolean);
  const header = lines[0] ?? "## ";
  const branchMatch = header.match(/^##\s+([^.\s]+)/);
  const aheadMatch = header.match(/ahead (\d+)/);
  const behindMatch = header.match(/behind (\d+)/);

  const staged: string[] = [];
  const modified: string[] = [];
  const notAdded: string[] = [];
  const deleted: string[] = [];
  const conflicted: string[] = [];

  for (const line of lines.slice(1)) {
    const x = line[0];
    const y = line[1];
    const file = line.slice(3);
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) conflicted.push(file);
    else {
      if (x !== " " && x !== "?") staged.push(file);
      if (y === "M") modified.push(file);
      if (y === "D") deleted.push(file);
      if (x === "?" && y === "?") notAdded.push(file);
    }
  }

  return {
    currentBranch: branchMatch?.[1] ?? "",
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
    staged,
    modified,
    notAdded,
    deleted,
    conflicted,
    isClean: staged.length === 0 && modified.length === 0 && notAdded.length === 0 && deleted.length === 0 && conflicted.length === 0,
  };
}

const LOG_FIELD_SEP = "\x1f";

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

    /** `git fetch` — updates remote-tracking refs from the remote; leaves the working tree and
     *  local branches untouched (n8n's Git node classifies this the same way). */
    async fetch(): Promise<{ success: true }> {
      await execFileAsync("git", ["-C", config.repoPath, "fetch"]);
      return { success: true };
    },

    /** `git status --porcelain=v1 -b`, parsed — read-only working-tree state, no writes. */
    async getStatus(): Promise<LocalGitStatus> {
      const { stdout } = await execFileAsync("git", ["-C", config.repoPath, "status", "--porcelain=v1", "-b"]);
      return parseStatusPorcelain(stdout);
    },

    /** `git log`, parsed — defaults to the current branch, most recent `maxCount` commits (default 20). */
    async getLog(options?: { maxCount?: number; branch?: string }): Promise<LocalGitLogEntry[]> {
      const maxCount = Math.min(Math.max(options?.maxCount ?? 20, 1), 200);
      const args = [
        "-C",
        config.repoPath,
        "log",
        `-n${maxCount}`,
        `--format=%H${LOG_FIELD_SEP}%s${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%ae${LOG_FIELD_SEP}%aI`,
      ];
      if (options?.branch) args.push(options.branch);
      const { stdout } = await execFileAsync("git", args);
      return stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, message, authorName, authorEmail, date] = line.split(LOG_FIELD_SEP);
          return { hash, message, authorName, authorEmail, date };
        });
    },

    /** `git config --list`, parsed into key/value pairs — read-only (no `Add Config`/writes). */
    async getConfigList(): Promise<LocalGitConfigEntry[]> {
      const { stdout } = await execFileAsync("git", ["-C", config.repoPath, "config", "--list"]);
      return stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const eq = line.indexOf("=");
          return eq === -1 ? { key: line, value: "" } : { key: line.slice(0, eq), value: line.slice(eq + 1) };
        });
    },

    /** `git ls-files` (already respects `.gitignore`) with each tracked text file's contents inlined,
     *  under a combined byte budget — the source for an AI Agent node to reason over "the whole
     *  project" without shipping the entire checkout (binaries, lockfiles, and oversized files are
     *  skipped; `truncated` reports whether the budget or file-count cap cut the walk short). */
    async listProjectFiles(options?: { maxTotalBytes?: number }): Promise<LocalGitProjectFiles> {
      const maxTotalBytes = Math.max(1, options?.maxTotalBytes ?? 500_000);
      const { stdout } = await execFileAsync("git", ["-C", config.repoPath, "ls-files"], {
        maxBuffer: 10 * 1024 * 1024,
      });
      const allPaths = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      const candidates = allPaths.slice(0, MAX_CANDIDATE_FILES);

      const files: LocalGitProjectFile[] = [];
      let totalBytes = 0;
      let truncated = allPaths.length > candidates.length;

      for (const relPath of candidates) {
        if (totalBytes >= maxTotalBytes) {
          truncated = true;
          break;
        }
        const ext = path.extname(relPath).toLowerCase();
        if (SKIP_EXTENSIONS.has(ext) || SKIP_FILENAMES.has(path.basename(relPath))) continue;

        let resolved: string;
        try {
          resolved = resolveWithinRepo(config.repoPath, relPath);
        } catch {
          continue;
        }

        const stat = await fs.stat(resolved).catch(() => undefined);
        if (!stat || !stat.isFile()) continue;
        if (stat.size > MAX_SINGLE_FILE_BYTES) {
          truncated = true;
          continue;
        }

        const raw = await fs.readFile(resolved, "utf-8").catch(() => undefined);
        if (raw === undefined || raw.includes(" ")) continue; // unreadable, or binary (NUL byte heuristic)

        const bytes = Buffer.byteLength(raw, "utf-8");
        if (totalBytes + bytes > maxTotalBytes) {
          truncated = true;
          break;
        }
        files.push({ path: relPath, content: raw, bytes });
        totalBytes += bytes;
      }

      return { files, fileCount: files.length, totalBytes, truncated };
    },

    /** `git grep -n -I` over tracked files (respects `.gitignore`) — `pattern` is a basic regex by
     *  default (git grep's own syntax), not a fixed string. Used as the no-embedding-API fallback for
     *  "does the codebase contain X" lookups (an AI agent's `search_code` tool): cheap, exact, but only
     *  as good as the keyword/regex it's given, unlike semantic search. `git grep` exits 1 (not an
     *  error) when nothing matches, so that case is caught and returned as an empty array. */
    async searchCode(pattern: string, options?: { maxResults?: number; ignoreCase?: boolean }): Promise<LocalGitSearchMatch[]> {
      const maxResults = Math.min(Math.max(options?.maxResults ?? 30, 1), 200);
      const args = ["-C", config.repoPath, "grep", "-n", "-I"];
      if (options?.ignoreCase !== false) args.push("-i");
      args.push("-e", pattern, "--");
      try {
        const { stdout } = await execFileAsync("git", args, { maxBuffer: 10 * 1024 * 1024 });
        return stdout
          .split("\n")
          .filter(Boolean)
          .slice(0, maxResults)
          .map((line) => {
            const firstColon = line.indexOf(":");
            const secondColon = line.indexOf(":", firstColon + 1);
            return {
              path: line.slice(0, firstColon),
              line: Number(line.slice(firstColon + 1, secondColon)) || 0,
              text: line.slice(secondColon + 1),
            };
          });
      } catch (error) {
        if ((error as { code?: number }).code === 1) return [];
        throw error;
      }
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
    async fetch() {
      return (await requireClient()).fetch();
    },
    async getStatus() {
      return (await requireClient()).getStatus();
    },
    async getLog(options?: { maxCount?: number; branch?: string }) {
      return (await requireClient()).getLog(options);
    },
    async getConfigList() {
      return (await requireClient()).getConfigList();
    },
    async listProjectFiles(options?: { maxTotalBytes?: number }) {
      return (await requireClient()).listProjectFiles(options);
    },
    async searchCode(pattern: string, options?: { maxResults?: number; ignoreCase?: boolean }) {
      return (await requireClient()).searchCode(pattern, options);
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
