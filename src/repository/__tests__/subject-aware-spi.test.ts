import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteProvider } from '../sqlite-provider.js';
import type { KnowledgeEntry } from '../../types/index.js';

function makeEntry(id: string, title: string, content: string): KnowledgeEntry {
  const now = new Date('2026-05-31T00:00:00.000Z');
  return {
    id,
    type: 'fact',
    title,
    content,
    summary: title,
    source: { type: 'manual', reference: `material:${id}`, timestamp: now },
    confidence: 0.95,
    status: 'active',
    tags: [],
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

describe('SQLiteProvider subject-aware injection SPI (FR-P03 AC7)', () => {
  let dir: string;
  let dbPath: string;
  let provider: SQLiteProvider;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kivo-spi-'));
    dbPath = join(dir, 'kivo.db');
    provider = new SQLiteProvider({ dbPath });
  });

  afterEach(async () => {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('fallbackFullTextSearch', () => {
    it('recalls entries by FTS5 trigram match and excludes superseded', async () => {
      await provider.save(makeEntry('e1', '向量检索原理', '向量检索通过余弦相似度排序候选知识。'));
      await provider.save(makeEntry('e2', '无关条目', '这是一条与查询无关的内容。'));
      const old = makeEntry('e3', '向量检索旧版', '向量检索的过时说明。');
      old.status = 'superseded';
      await provider.save(old);

      const results = await provider.fallbackFullTextSearch('向量检索', 10);
      const ids = results.map(r => r.entry.id);

      expect(ids).toContain('e1');
      expect(ids).not.toContain('e3'); // superseded excluded
      expect(results.every(r => r.score > 0 && r.score <= 1)).toBe(true);
    });

    it('returns [] for empty query', async () => {
      await provider.save(makeEntry('e1', 'title', 'content'));
      expect(await provider.fallbackFullTextSearch('   ', 10)).toEqual([]);
    });
  });

  describe('expandGraphOneHop', () => {
    it('returns [] when graph_edges table does not exist', async () => {
      await provider.save(makeEntry('e1', 'seed', 'seed content'));
      expect(await provider.expandGraphOneHop(['e1'])).toEqual([]);
    });

    it('expands one hop from seeds and skips self/other seeds', async () => {
      await provider.save(makeEntry('seed', '种子', '种子内容'));
      await provider.save(makeEntry('n1', '邻居一', '邻居一内容'));
      await provider.save(makeEntry('n2', '邻居二', '邻居二内容'));

      // Write graph_edges via a second connection to the same DB file.
      const aux = new Database(dbPath);
      aux.exec(`
        CREATE TABLE IF NOT EXISTS graph_edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          association_type TEXT NOT NULL,
          edge_source TEXT NOT NULL DEFAULT 'test',
          weight REAL NOT NULL DEFAULT 0.5
        );
      `);
      const insert = aux.prepare(
        'INSERT INTO graph_edges (source_id, target_id, association_type, edge_source, weight) VALUES (?, ?, ?, ?, ?)'
      );
      insert.run('seed', 'n1', 'explains', 'test', 0.8);   // seed → n1
      insert.run('n2', 'seed', 'requires', 'test', 0.6);   // n2 → seed (reverse direction)
      aux.close();

      const results = await provider.expandGraphOneHop(['seed'], { limitPerSeed: 5 });
      const byId = new Map(results.map(r => [r.entry.id, r]));

      expect(byId.has('n1')).toBe(true);
      expect(byId.has('n2')).toBe(true);
      expect(byId.has('seed')).toBe(false); // no self-loop
      expect(byId.get('n1')?.strength).toBeCloseTo(0.8, 5);
      expect(byId.get('n1')?.relationType).toBe('explains');
      expect(byId.get('n1')?.seedEntryId).toBe('seed');
      expect(byId.get('n2')?.relationType).toBe('requires');
      expect(byId.get('n2')?.seedEntryId).toBe('seed');
    });

    it('respects limitPerSeed', async () => {
      await provider.save(makeEntry('seed', '种子', '种子内容'));
      await provider.save(makeEntry('a', 'A', 'A 内容'));
      await provider.save(makeEntry('b', 'B', 'B 内容'));
      await provider.save(makeEntry('c', 'C', 'C 内容'));

      const aux = new Database(dbPath);
      aux.exec(`
        CREATE TABLE IF NOT EXISTS graph_edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          association_type TEXT NOT NULL,
          edge_source TEXT NOT NULL DEFAULT 'test',
          weight REAL NOT NULL DEFAULT 0.5
        );
      `);
      const insert = aux.prepare(
        'INSERT INTO graph_edges (source_id, target_id, association_type, edge_source, weight) VALUES (?, ?, ?, ?, ?)'
      );
      insert.run('seed', 'a', 'explains', 'test', 0.9);
      insert.run('seed', 'b', 'explains', 'test', 0.7);
      insert.run('seed', 'c', 'explains', 'test', 0.5);
      aux.close();

      const results = await provider.expandGraphOneHop(['seed'], { limitPerSeed: 2 });
      expect(results).toHaveLength(2);
      // Highest weights kept (ordered by weight DESC).
      expect(results.map(r => r.entry.id)).toEqual(['a', 'b']);
    });

    it('returns [] for empty seed list', async () => {
      expect(await provider.expandGraphOneHop([])).toEqual([]);
    });
  });
});
