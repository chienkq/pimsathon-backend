/**
 * In-memory status tracker for Jira Excel import jobs. Parsing + upserting a real Jira export can take
 * a few seconds (hundreds of issues, a wide `raw` payload per row), so the upload route hands the file
 * off to a background task and returns a job id immediately instead of holding the HTTP request open —
 * the client polls `GET .../import-excel/:jobId` for progress. In-memory (not a DB table) because a job
 * only needs to survive one browser session; a backend restart mid-import is rare enough to just re-run.
 */
export interface JiraImportJob {
  id: string;
  status: "processing" | "completed" | "failed";
  imported?: number;
  skipped?: number;
  error?: string;
  createdAt: string;
}

export interface JiraImportJobStore {
  create(): JiraImportJob;
  get(id: string): JiraImportJob | undefined;
  complete(id: string, result: { imported: number; skipped: number }): void;
  fail(id: string, error: string): void;
}

export function createJiraImportJobStore(): JiraImportJobStore {
  const jobs = new Map<string, JiraImportJob>();

  return {
    create() {
      const job: JiraImportJob = { id: crypto.randomUUID(), status: "processing", createdAt: new Date().toISOString() };
      jobs.set(job.id, job);
      return job;
    },
    get(id) {
      return jobs.get(id);
    },
    complete(id, { imported, skipped }) {
      const job = jobs.get(id);
      if (job) Object.assign(job, { status: "completed", imported, skipped });
    },
    fail(id, error) {
      const job = jobs.get(id);
      if (job) Object.assign(job, { status: "failed", error });
    },
  };
}
