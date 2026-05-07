import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { runInit } from '../src/cli/init.js';
import { seedKnowledge } from '../src/seed/seed-knowledge.js';
import { runQuery } from '../src/cli/query.js';

describe('value-layer: seedKnowledge', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'kivo-value-'));
    await runInit({ dir: testDir, nonInteractive: true });
    dbPath = join(testDir, 'kivo.db');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('seeds 6 entries into empty database', () => {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) as cnt FROM entries').get() as { cnt: number };
    db.close();
    expect(row.cnt).toBe(6);
  });

  it('is idempotent — second call returns 0', () => {
    const result = seedKnowledge(dbPath);
    expect(result).toBe(0);
  });

  it('populates FTS5 index for seed data', () => {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(`
      SELECT e.title FROM entries e
      JOIN entries_fts ON entries_fts.rowid = e.rowid
      WHERE entries_fts MATCH '"KIVO"'
    `).all() as Array<{ title: string }>;
    db.close();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].title).toContain('KIVO');
  });
});

// PLACEHOLDER_QUERY_TESTS

describe('value-layer: runQuery', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'kivo-query-'));
    await runInit({ dir: testDir, nonInteractive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('FTS5 search finds matching entries', async () => {
    const result = await runQuery('KIVO');
    expect(result).toContain('KIVO');
    expect(result).toContain('Found');
  });

  it('LIKE fallback works when FTS5 has no match', async () => {
    const result = await runQuery('SQLite');
    expect(result).toContain('SQLite');
  });

  it('handles FTS5 special characters without crashing', async () => {
    const result = await runQuery('test AND "hello" OR (world)');
    expect(result).not.toContain('Error');
  });

  it('Chinese keyword extraction finds results', async () => {
    const result = await runQuery('数据库存储');
    expect(result).toContain('Found');
  });

  it('returns no-results message for unmatched query', async () => {
    const result = await runQuery('xyznonexistent999');
    expect(result).toContain('No results');
  });
});

describe('value-layer: checkKnowledgeEntries (via health check)', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'kivo-health-'));
    await runInit({ dir: testDir, nonInteractive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('reports correct entry count after init', async () => {
    const { runHealthCheck } = await import('../src/cli/health-check.js');
    const report = await runHealthCheck(join(testDir, 'kivo.config.json'));
    const kbItem = report.items.find(i => i.name === 'Knowledge Base');
    expect(kbItem).toBeDefined();
    expect(kbItem!.status).toBe('ok');
    expect(kbItem!.detail).toBe('6 entries');
  });
});