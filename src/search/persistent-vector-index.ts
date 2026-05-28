import Database from 'better-sqlite3';
import { VectorIndex } from './vector-index.js';

export interface PersistentVectorIndexOptions {
  db: Database.Database;
}

export class PersistentVectorIndex extends VectorIndex {
  private readonly db: Database.Database;

  constructor(options: PersistentVectorIndexOptions) {
    super();
    this.db = options.db;
    this.initSchema();
    this.loadFromDb();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vector_store (
        entry_id   TEXT PRIMARY KEY,
        vector     BLOB NOT NULL,
        dimensions INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  private loadFromDb(): void {
    const rows = this.db.prepare(
      'SELECT entry_id, vector, dimensions FROM vector_store',
    ).all() as Array<{ entry_id: string; vector: Buffer; dimensions: number }>;

    for (const row of rows) {
      const float64 = new Float64Array(row.vector.buffer, row.vector.byteOffset, row.dimensions);
      super.addVector(row.entry_id, Array.from(float64));
    }
  }

  override addVector(id: string, vector: number[]): void {
    super.addVector(id, vector);
    const buf = Buffer.from(new Float64Array(vector).buffer);
    this.db.prepare(`
      INSERT OR REPLACE INTO vector_store (entry_id, vector, dimensions, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(id, buf, vector.length, new Date().toISOString());
  }

  override remove(id: string): boolean {
    const existed = super.remove(id);
    if (existed) {
      this.db.prepare('DELETE FROM vector_store WHERE entry_id = ?').run(id);
    }
    return existed;
  }
}
