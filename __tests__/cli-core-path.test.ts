import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInit } from '../src/cli/init.js';
import { Kivo } from '../src/kivo.js';

describe('CLI core path: init → ingest → query', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'kivo-cli-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('init creates config and database', async () => {
    const output = await runInit({ dir: testDir, nonInteractive: true });

    expect(output).toContain('✓');
    expect(existsSync(join(testDir, 'kivo.config.json'))).toBe(true);
    expect(existsSync(join(testDir, 'kivo.db'))).toBe(true);
  });

  it('full round-trip: init → ingest → query', async () => {
    // Step 1: init
    await runInit({ dir: testDir, nonInteractive: true });
    const dbPath = join(testDir, 'kivo.db');
    expect(existsSync(dbPath)).toBe(true);

    // Step 2: create Kivo instance and ingest
    const kivo = new Kivo({ dbPath, mode: 'standalone' });
    await kivo.init();

    const ingestResult = await kivo.ingest(
      'Rust 是一门注重安全性和性能的系统编程语言。',
      'cli-test',
    );
    expect(ingestResult.entries.length).toBeGreaterThan(0);
    expect(ingestResult.taskId).toBeDefined();

    // Step 3: query
    const results = await kivo.query('Rust');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content).toContain('Rust');

    await kivo.shutdown();
  });

  it('init with default options succeeds', async () => {
    const output = await runInit({ dir: testDir, nonInteractive: true });

    expect(output).toContain('Config written');
    expect(output).toContain('Database initialized');
    expect(output).toContain('KIVO 已就绪');
  });

  it('schema matches SQLiteProvider expectations', async () => {
    // init creates DB, then SQLiteProvider should be able to use it
    await runInit({ dir: testDir, nonInteractive: true });
    const dbPath = join(testDir, 'kivo.db');

    // If schema mismatches, Kivo.init() or ingest() would throw
    const kivo = new Kivo({ dbPath, mode: 'standalone' });
    await kivo.init();

    // Use meaningful content so the extraction pipeline produces entries
    const result = await kivo.ingest(
      'PostgreSQL 是一个功能强大的开源关系型数据库管理系统。',
      'schema-test',
    );
    expect(result.entries.length).toBeGreaterThan(0);

    // Verify we can query back
    const results = await kivo.query('PostgreSQL');
    expect(results.length).toBeGreaterThan(0);

    await kivo.shutdown();
  });
});
