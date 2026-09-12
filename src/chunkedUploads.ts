/**
 * In-memory reassembly buffer for large JSON request bodies sent in small sequential chunks — the
 * fix for "Payload Too Large" on `/api/workflows/:id/run` and `/api/node-types/:type/execute` (an ad-hoc
 * workflow definition, or a git node's "Read Project Files" output flowing through the NDV Execute
 * button, can easily blow past any single-request body limit). A client that has something large to
 * send starts a session (`POST /api/uploads`), appends it as small chunks (`POST /api/uploads/:id/chunks`,
 * each well under Fastify's `bodyLimit`), then sends its real request with `{ uploadId }` in place of
 * the inline payload — the consuming route resolves it via `finishUpload`. In-memory only (not a DB
 * table): a session only needs to survive the handful of requests one upload takes, and a backend
 * restart mid-upload is rare enough to just have the client retry.
 */
interface UploadSession {
  /** Sparse, indexed by chunk index — chunks are expected to arrive in order (the client awaits each
   *  one before sending the next), but indexing rather than blind-appending guards against a
   *  duplicated/retried chunk silently corrupting the reassembled JSON. */
  chunks: string[];
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

export interface ChunkedUploadStore {
  start(): string;
  appendChunk(uploadId: string, index: number, data: string): void;
  /** Reassembles and JSON-parses the full payload, then discards the session — an upload is single-use. */
  finish<T>(uploadId: string): T;
}

export function createChunkedUploadStore(): ChunkedUploadStore {
  const sessions = new Map<string, UploadSession>();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.createdAt > TTL_MS) sessions.delete(id);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  return {
    start() {
      const uploadId = crypto.randomUUID();
      sessions.set(uploadId, { chunks: [], createdAt: Date.now() });
      return uploadId;
    },
    appendChunk(uploadId, index, data) {
      const session = sessions.get(uploadId);
      if (!session) throw new Error(`Unknown or expired upload: ${uploadId}`);
      session.chunks[index] = data;
    },
    finish<T>(uploadId: string): T {
      const session = sessions.get(uploadId);
      if (!session) throw new Error(`Unknown or expired upload: ${uploadId}`);
      sessions.delete(uploadId);
      if (session.chunks.some((chunk) => chunk === undefined)) {
        throw new Error(`Upload ${uploadId} is missing chunks — reassembly would be corrupt.`);
      }
      return JSON.parse(session.chunks.join("")) as T;
    },
  };
}
