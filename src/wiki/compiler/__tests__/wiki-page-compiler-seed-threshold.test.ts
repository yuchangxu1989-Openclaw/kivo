import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { WikiPageCompiler } from '../wiki-page-compiler.js';
import { initializeWikiSchema } from '../../db/schema.js';

vi.mock('../../../cli/resolve-llm-config.js', () => ({
  resolveLlmConfig: () => ({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test' }),
}));

const now = '2026-05-24T00:00:00.000Z';

function createBaseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE subject_nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      level INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      merged_into TEXT
    );
    CREATE TABLE materials (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      subject_node_id TEXT,
      suggested_subject_name TEXT,
      pipeline_status TEXT,
      status TEXT,
      created_at TEXT
    );
    CREATE TABLE graph_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      target_id TEXT,
      association_type TEXT,
      weight REAL
    );
  `);
}

function insertSubject(db: Database.Database, id: string, name: string): void {
  db.prepare(`INSERT INTO subject_nodes (id, name, level, status) VALUES (?, ?, 0, 'active')`).run(id, name);
}

function insertEntry(db: Database.Database, id: string, subjectId: string): void {
  db.prepare(`
    INSERT INTO entries (
      id, type, title, content, summary, source_json, status, tags_json,
      version, metadata_json, subject_id, parent_id, sort_order, created_at, updated_at
    ) VALUES (?, 'fact', ?, ?, '', '{}', 'active', '[]', 1, '{}', ?, NULL, 0, ?, ?)
  `).run(id, `条目 ${id}`, `内容 ${id}`, subjectId, now, now);
}

describe('WikiPageCompiler seed threshold', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kivo-wiki-compiler-'));
    dbPath = join(dir, 'kivo.db');
    const db = new Database(dbPath);
    createBaseSchema(db);
    initializeWikiSchema(db, { enableForeignKeys: false });
    insertSubject(db, 'empty-subject', '空学科');
    insertSubject(db, 'active-subject', '有条目学科');
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('skips subjects with zero atomic entries and only compiles subjects with entries', async () => {
    const setupDb = new Database(dbPath);
    insertEntry(setupDb, 'entry-1', 'active-subject');
    setupDb.close();

    const compiler = new WikiPageCompiler(dbPath, { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test', model: 'test-model' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = await compiler.compileSubjects(['empty-subject', 'active-subject']);

      expect(result.items.map((item) => item.subjectId)).toEqual(['active-subject']);
      expect(result.pagesCreated).toBe(1);
      expect(result.pagesUpdated).toBe(1);
      expect(result.items[0]?.entryCount).toBe(1);
      expect(logSpy).toHaveBeenCalledWith('[wiki-compiler] skip subject=empty-subject: entries=0');
    } finally {
      compiler.close();
    }

    const verifyDb = new Database(dbPath);
    const pages = verifyDb.prepare(`SELECT subject_id FROM entries WHERE type = 'wiki_page' ORDER BY subject_id`).all() as Array<{ subject_id: string }>;
    verifyDb.close();

    expect(pages).toEqual([{ subject_id: 'active-subject' }]);
  });

  it('uses default threshold (>=1 entry) without any ProjectConfig argument', async () => {
    const setupDb = new Database(dbPath);
    insertEntry(setupDb, 'entry-default', 'active-subject');
    setupDb.close();

    // 默认阈值=1：不传 ProjectConfig / 不调何函数入参，仅靠 compiler 内部默认逻辑。
    const compiler = new WikiPageCompiler(dbPath, {
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test',
      model: 'test-model',
    });

    try {
      const result = await compiler.compileSubjects(['empty-subject', 'active-subject']);

      // empty-subject 被阈值跳过；active-subject 不被跳过。
      expect(result.items.map((item) => item.subjectId)).toEqual(['active-subject']);
      expect(result.errors).toEqual([]);
    } finally {
      compiler.close();
    }
  });

  it('compiles no pages when all subjects have zero entries (boundary)', async () => {
    // 边界用例：全部 subject 都是空节点，阈值門禁后不应该编译任何 wiki_page。
    const compiler = new WikiPageCompiler(dbPath, {
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test',
      model: 'test-model',
    });

    try {
      const result = await compiler.compileSubjects(['empty-subject', 'active-subject']);

      expect(result.items).toEqual([]);
      expect(result.pagesCreated).toBe(0);
      expect(result.pagesUpdated).toBe(0);
      expect(result.errors).toEqual([]);
    } finally {
      compiler.close();
    }

    const verifyDb = new Database(dbPath);
    const wikiCount = verifyDb.prepare(`SELECT COUNT(*) AS c FROM entries WHERE type = 'wiki_page'`).get() as { c: number };
    verifyDb.close();
    expect(wikiCount.c).toBe(0);
  });
});
