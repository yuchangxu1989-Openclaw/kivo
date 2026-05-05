/**
 * VectorStore — SQLite-backed vector storage with cosine similarity search.
 *
 * Stores embeddings as Float32Array BLOBs in the entries table.
 * For datasets <10k, computes cosine similarity in JS (no vector DB needed).
 */

import Database from 'better-sqlite3';
import { cosineSimilarity } from '../utils/math.js';

export interface VectorSearchResult {
  entryId: string;
  score: number;
}

export interface VectorStoreOptions {
  dbPath: string;
}

export class VectorStore {
  private db: Database.Database;

  constructor(options: VectorStoreOptions) {
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    // Add embedding column to entries if not exists
    const columns = this.db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>;
    const hasEmbedding = columns.some(c => c.name === 'embedding');
    if (!hasEmbedding) {
      this.db.exec('ALTER TABLE entries ADD COLUMN embedding BLOB');
    }
  }

  /** Store an embedding vector for an entry */
  storeEmbedding(entryId: string, vector: number[]): void {
    const buf = Buffer.from(new Float32Array(vector).buffer);
    this.db.prepare('UPDATE entries SET embedding = ? WHERE id = ?').run(buf, entryId);
  }

  /** Retrieve the embedding for an entry */
  getEmbedding(entryId: string): number[] | null {
    const row = this.db.prepare('SELECT embedding FROM entries WHERE id = ?').get(entryId) as { embedding: Buffer | null } | undefined;
    if (!row?.embedding) return null;
    const float32 = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    return Array.from(float32);
  }

  /** Search for similar entries by cosine similarity */
  searchSimilar(queryVector: number[], topK: number = 10): VectorSearchResult[] {
    const rows = this.db.prepare(
      'SELECT id, embedding FROM entries WHERE embedding IS NOT NULL'
    ).all() as Array<{ id: string; embedding: Buffer }>;

    const results: VectorSearchResult[] = [];

    for (const row of rows) {
      const float32 = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const vec = Array.from(float32);
      const score = cosineSimilarity(queryVector, vec);
      results.push({ entryId: row.id, score });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Check if two vectors are near-duplicates (similarity > threshold) */
  isDuplicate(vector: number[], threshold: number = 0.95): boolean {
    const results = this.searchSimilar(vector, 1);
    return results.length > 0 && results[0].score > threshold;
  }

  /** Count entries with embeddings */
  embeddingCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM entries WHERE embedding IS NOT NULL').get() as { cnt: number };
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}
