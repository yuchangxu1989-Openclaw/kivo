import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { VectorStore } from '../src/search/vector-store.js';

function createTestDb(dir: string): string {
  const dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      tags_json TEXT NOT NULL DEFAULT '[]',
      domain TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      supersedes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO entries (id, type, title, content, source_json, confidence, tags_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('e1', 'fact', 'Test Entry 1', 'Content about AI', '{}', 0.9, '["ai"]', now, now);
  db.prepare(`
    INSERT INTO entries (id, type, title, content, source_json, confidence, tags_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('e2', 'methodology', 'Test Entry 2', 'Content about coding', '{}', 0.8, '["code"]', now, now);
  db.close();
  return dbPath;
}

describe('VectorStore', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'kivo-vs-'));
    dbPath = createTestDb(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('adds embedding column on init', () => {
    const store = new VectorStore({ dbPath });
    const db = new Database(dbPath, { readonly: true });
    const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
    db.close();
    store.close();
    expect(columns.some(c => c.name === 'embedding')).toBe(true);
  });

  it('stores and retrieves embeddings', () => {
    const store = new VectorStore({ dbPath });
    const vec = [0.1, 0.2, 0.3, 0.4, 0.5];
    store.storeEmbedding('e1', vec);

    const retrieved = store.getEmbedding('e1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.length).toBe(5);
    // Float32 precision
    expect(retrieved![0]).toBeCloseTo(0.1, 5);
    expect(retrieved![4]).toBeCloseTo(0.5, 5);
    store.close();
  });

  it('returns null for entries without embeddings', () => {
    const store = new VectorStore({ dbPath });
    const retrieved = store.getEmbedding('e2');
    expect(retrieved).toBeNull();
    store.close();
  });

  it('searches by cosine similarity', () => {
    const store = new VectorStore({ dbPath });
    // Store two different vectors
    store.storeEmbedding('e1', [1, 0, 0, 0, 0]);
    store.storeEmbedding('e2', [0, 1, 0, 0, 0]);

    // Query close to e1
    const results = store.searchSimilar([0.9, 0.1, 0, 0, 0], 2);
    expect(results.length).toBe(2);
    expect(results[0].entryId).toBe('e1');
    expect(results[0].score).toBeGreaterThan(results[1].score);
    store.close();
  });

  it('detects duplicates by vector similarity', () => {
    const store = new VectorStore({ dbPath });
    store.storeEmbedding('e1', [1, 0, 0, 0, 0]);

    // Very similar vector should be detected as duplicate
    expect(store.isDuplicate([0.99, 0.01, 0, 0, 0], 0.95)).toBe(true);
    // Different vector should not
    expect(store.isDuplicate([0, 1, 0, 0, 0], 0.95)).toBe(false);
    store.close();
  });

  it('counts entries with embeddings', () => {
    const store = new VectorStore({ dbPath });
    expect(store.embeddingCount()).toBe(0);
    store.storeEmbedding('e1', [1, 0, 0]);
    expect(store.embeddingCount()).toBe(1);
    store.storeEmbedding('e2', [0, 1, 0]);
    expect(store.embeddingCount()).toBe(2);
    store.close();
  });
});

describe('BgeEmbedder', () => {
  it('reports availability correctly', async () => {
    const { BgeEmbedder } = await import('../src/extraction/bge-embedder.js');
    const available = BgeEmbedder.isAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('has correct dimensions', async () => {
    const { BgeEmbedder } = await import('../src/extraction/bge-embedder.js');
    const embedder = new BgeEmbedder();
    expect(embedder.dimensions()).toBe(512);
    expect(embedder.modelId()).toBe('bge-small-zh-v1.5');
  });
});
