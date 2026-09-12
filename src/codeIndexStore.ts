import type { CodeChunkRecord, CodeSearchResult } from "@chienkq/workflow-core";
import { codeChunks, type WorkflowDb } from "@chienkq/workflow-db";
import { sql } from "drizzle-orm";

export interface EmbeddedCodeChunk extends CodeChunkRecord {
  embedding: number[];
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Backing store for the `codeIndex`/`codeSearch` node types — a pgvector-backed index of TS/JS
 * function/class/method chunks. `replaceAll` is a full wipe-and-reinsert (today's "Reindex" is
 * whole-repo, not incremental per changed file — a documented simplification, not a gap to silently
 * work around). `search` ranks by pgvector's `<=>` cosine-distance operator, converted to a 0..1
 * "closer is higher" score for display.
 */
export function createCodeIndexStore(db: WorkflowDb) {
  return {
    async replaceAll(chunks: EmbeddedCodeChunk[]): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.delete(codeChunks);
        const BATCH_SIZE = 200;
        for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
          const batch = chunks.slice(i, i + BATCH_SIZE);
          if (batch.length === 0) continue;
          await tx.insert(codeChunks).values(
            batch.map((chunk) => ({
              id: crypto.randomUUID(),
              filePath: chunk.filePath,
              symbolName: chunk.symbolName,
              kind: chunk.kind,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              content: chunk.content,
              embedding: chunk.embedding,
            }))
          );
        }
      });
    },

    async count(): Promise<number> {
      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(codeChunks);
      return row?.count ?? 0;
    },

    async search(queryEmbedding: number[], topK: number): Promise<CodeSearchResult[]> {
      const literal = toVectorLiteral(queryEmbedding);
      const rows = (await db.execute(sql`
        select file_path, symbol_name, kind, start_line, end_line, content,
               1 - (embedding <=> ${literal}::vector) as score
        from code_chunks
        order by embedding <=> ${literal}::vector
        limit ${topK}
      `)) as unknown as Array<{
        file_path: string;
        symbol_name: string;
        kind: string;
        start_line: number;
        end_line: number;
        content: string;
        score: number;
      }>;

      return rows.map((row) => ({
        filePath: row.file_path,
        symbolName: row.symbol_name,
        kind: row.kind as CodeChunkRecord["kind"],
        startLine: row.start_line,
        endLine: row.end_line,
        content: row.content,
        score: Number(row.score),
      }));
    },
  };
}

export type CodeIndexStore = ReturnType<typeof createCodeIndexStore>;
