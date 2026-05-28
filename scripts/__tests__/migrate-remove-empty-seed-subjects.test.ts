/**
 * Migration script test: scripts/migrate-remove-empty-seed-subjects.ts
 *
 * Hermes (OpenClaw ACP Agent) / 2026-05-24
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runSeedCleanup } from '../migrate-remove-empty-seed-subjects.js';

const now = '2026-05-24T00:00:00.000Z';

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE subject_nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      level INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      merged_into TEXT
    );
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      content TEXT,
      summary TEXT,
      source_json TEXT,
      status TEXT DEFAULT 'active',
      tags_json TEXT,
      version INTEGER DEFAULT 1,
      metadata_json TEXT,
      subject_id TEXT,
      parent_id TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE wiki_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_page_id TEXT,
      target_page_id TEXT,
      target_title TEXT,
      label TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE wiki_page_versions (
      id TEXT PRIMARY KEY,
      page_id TEXT,
      version INTEGER,
      title TEXT,
      content TEXT,
      summary TEXT,
      tags_json TEXT,
      metadata_json TEXT,
      created_at TEXT
    );
  `);
}

function insertSubject(db: Database.Database, id: string, name: string): void {
  db.prepare(`INSERT INTO subject_nodes (id, name, level, status) VALUES (?, ?, 0, 'active')`).run(id, name);
}

function insertAtomicEntry(db: Database.Database, id: string, subjectId: string): void {
  db.prepare(`
    INSERT INTO entries (id, type, title, content, summary, source_json, status, tags_json, version, metadata_json, subject_id, parent_id, sort_order, created_at, updated_at)
    VALUES (?, 'fact', ?, ?, '', '{}', 'active', '[]', 1, '{}', ?, NULL, 0, ?, ?)
  `).run(id, `t-${id}`, `c-${id}`, subjectId, now, now);
}

function insertEmptyShellPage(db: Database.Database, id: string, subjectId: string | null): void {
  db.prepare(`
    INSERT INTO entries (id, type, title, content, summary, source_json, status, tags_json, version, metadata_json, subject_id, parent_id, sort_order, created_at, updated_at)
    VALUES (?, 'wiki_page', ?, '', '', '{}', 'active', '[]', 1, '{}', ?, NULL, 0, ?, ?)
  `).run(id, `shell-${id}`, subjectId, now, now);
}

describe('migrate-remove-empty-seed-subjects', () => {
  let dir: string;
  let dbPath: string;
  let backupPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kivo-migrate-test-'));
    dbPath = join(dir, 'kivo.db');
    backupPath = join(dir, 'kivo.db.bak');

    const db = new Database(dbPath);
    createSchema(db);

    // 保留节点（有 entries）
    insertSubject(db, 'keep-subject', '保留学科');
    insertAtomicEntry(db, 'entry-keep-1', 'keep-subject');

    // 全空 seed 节点（零 entries）
    insertSubject(db, 'empty-seed', '空子服务节点');

    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a backup file before mutating the DB', () => {
    expect(existsSync(backupPath)).toBe(false);
    const result = runSeedCleanup(dbPath, backupPath);
    expect(existsSync(backupPath)).toBe(true);
    // 备份文件不应为空
    expect(statSync(backupPath).size).toBeGreaterThan(0);
    expect(result.deletedSubjects).toBe(1);
  });

  it('purges global empty wiki_page shells regardless of subject node retention', () => {
    // 在保留节点下手动插 3 个空壳（模拟实库概率论节点下的残留）。
    const db = new Database(dbPath);
    insertEmptyShellPage(db, 'shell-1', 'keep-subject');
    insertEmptyShellPage(db, 'shell-2', 'keep-subject');
    insertEmptyShellPage(db, 'shell-3', null); // 孤儿空壳
    db.close();

    const result = runSeedCleanup(dbPath, backupPath);
    expect(result.globalShellPages).toBe(3);

    const verifyDb = new Database(dbPath);
    const shellCount = verifyDb.prepare(`
      SELECT COUNT(*) AS c FROM entries
       WHERE type = 'wiki_page'
         AND length(COALESCE(content, '')) = 0
         AND (COALESCE(metadata_json, '') = '{}' OR metadata_json IS NULL)
    `).get() as { c: number };
    verifyDb.close();
    expect(shellCount.c).toBe(0);
  });

  it('is idempotent: running twice yields the same final state', () => {
    const db = new Database(dbPath);
    insertEmptyShellPage(db, 'shell-x1', 'keep-subject');
    insertEmptyShellPage(db, 'shell-x2', null);
    db.close();

    const first = runSeedCleanup(dbPath, backupPath);

    const snapshotDb = new Database(dbPath);
    const subjectsAfter1 = snapshotDb.prepare(`SELECT id FROM subject_nodes ORDER BY id`).all();
    const wikiAfter1 = snapshotDb.prepare(`SELECT id FROM entries WHERE type='wiki_page' ORDER BY id`).all();
    snapshotDb.close();

    // 第二轮：清掉旧备份避免 copyFileSync 同名覆盖问题
    rmSync(backupPath, { force: true });
    const second = runSeedCleanup(dbPath, backupPath);

    const verifyDb = new Database(dbPath);
    const subjectsAfter2 = verifyDb.prepare(`SELECT id FROM subject_nodes ORDER BY id`).all();
    const wikiAfter2 = verifyDb.prepare(`SELECT id FROM entries WHERE type='wiki_page' ORDER BY id`).all();
    verifyDb.close();

    expect(subjectsAfter2).toEqual(subjectsAfter1);
    expect(wikiAfter2).toEqual(wikiAfter1);
    expect(second.deletedSubjects).toBe(0);
    expect(second.globalShellPages).toBe(0);
    expect(first.deletedSubjects).toBeGreaterThanOrEqual(0);
  });
});
