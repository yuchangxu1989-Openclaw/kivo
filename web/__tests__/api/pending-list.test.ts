/**
 * Pending List Tests — KIVO Wave 1 / C1
 * AC-PENDING-1.1：list 分页 + 过滤
 *
 * 使用临时 file-based SQLite，覆盖：
 *   - 空队列 → total 0
 *   - 多条 pending → 默认按 created_at desc
 *   - source 过滤
 *   - subject_hint 过滤（命中 suggested_subject_name 与 subject_nodes.name）
 *   - 分页边界
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = 'http://localhost:3000';

let dbPath: string;
let db: Database.Database;

function makeGet(query = ''): NextRequest {
  return new NextRequest(new URL(`/api/pending/list${query}`, BASE));
}

function setupSchema(target: Database.Database) {
  target.exec(`
    CREATE TABLE materials (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL,
      space_id TEXT NOT NULL DEFAULT 'default',
      wiki_page_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      wiki_page_ids_json TEXT NOT NULL DEFAULT '[]',
      error_message TEXT,
      subject_node_id TEXT,
      classification_status TEXT DEFAULT 'pending',
      classification_confidence REAL,
      suggested_subject_name TEXT,
      pipeline_status TEXT,
      slice_count INTEGER DEFAULT 0,
      extract_count INTEGER DEFAULT 0,
      inject_count INTEGER DEFAULT 0,
      asset_kind TEXT,
      source_channel TEXT,
      source_ref TEXT
    );
    CREATE TABLE subject_nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      tree_kind TEXT NOT NULL DEFAULT 'subject',
      origin TEXT NOT NULL DEFAULT 'auto',
      created_by_material_id TEXT,
      created_at INTEGER NOT NULL,
      confidence REAL,
      aliases TEXT,
      merged_into TEXT,
      level INTEGER DEFAULT 0
    );
    CREATE TABLE personal_state (
      learner_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      mastery TEXT,
      confidence REAL,
      evidence_count INTEGER DEFAULT 0,
      last_seen INTEGER,
      review_plan TEXT,
      weak_reason TEXT,
      mistake_records_json TEXT,
      PRIMARY KEY (learner_id, entry_id)
    );
  `);
}

function insertSubject(target: Database.Database, id: string, name: string) {
  target
    .prepare(
      `INSERT INTO subject_nodes (id, parent_id, name, tree_kind, origin, created_at, level)
       VALUES (?, NULL, ?, 'subject', 'manual', ?, 0)`,
    )
    .run(id, name, Date.now());
}

interface MaterialSeed {
  id: string;
  classification_status?: string;
  source_channel?: string;
  suggested_subject_name?: string | null;
  subject_node_id?: string | null;
  created_at?: string;
}

function insertMaterial(target: Database.Database, seed: MaterialSeed) {
  const now = seed.created_at ?? new Date().toISOString();
  target
    .prepare(
      `INSERT INTO materials
        (id, file_name, mime_type, file_size, status, space_id,
         created_at, updated_at, storage_path,
         classification_status, source_channel, suggested_subject_name,
         subject_node_id)
       VALUES (?, ?, 'application/pdf', 1024, 'processing', 'default',
               ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.id,
      `${seed.id}.pdf`,
      now,
      now,
      `/tmp/${seed.id}.pdf`,
      seed.classification_status ?? 'pending',
      seed.source_channel ?? 'web_upload',
      seed.suggested_subject_name ?? null,
      seed.subject_node_id ?? null,
    );
}

beforeAll(() => {
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'kivo-pending-list-')), 'kivo.db');
  process.env.KIVO_DB_PATH = dbPath;
});

beforeEach(async () => {
  db?.close();
  db = new Database(dbPath);
  db.exec(`
    DROP TABLE IF EXISTS materials;
    DROP TABLE IF EXISTS subject_nodes;
    DROP TABLE IF EXISTS personal_state;
  `);
  setupSchema(db);
  const repoMod = await import('@/lib/pending/repository');
  repoMod.resetPendingRepositoryForTests();
});

afterAll(() => {
  db?.close();
});

describe('GET /api/pending/list', () => {
  it('returns empty page for empty queue', async () => {
    const mod = await import('../../app/api/pending/list/route');
    const res = await mod.GET(makeGet());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { total: number; page: number; pageSize: number } };
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
    expect(body.meta.page).toBe(1);
    expect(body.meta.pageSize).toBe(20);
  });

  it('lists pending entries newest-first and excludes classified rows', async () => {
    insertMaterial(db, { id: 'm-old', classification_status: 'pending', created_at: '2026-05-20T00:00:00.000Z' });
    insertMaterial(db, { id: 'm-mid', classification_status: 'needs_review', created_at: '2026-05-22T00:00:00.000Z' });
    insertMaterial(db, { id: 'm-new', classification_status: 'in_progress', created_at: '2026-05-24T00:00:00.000Z' });
    insertMaterial(db, { id: 'm-done', classification_status: 'classified', created_at: '2026-05-23T00:00:00.000Z' });

    const mod = await import('../../app/api/pending/list/route');
    const res = await mod.GET(makeGet());
    const body = (await res.json()) as { data: Array<{ entryId: string }>; meta: { total: number } };

    expect(body.meta.total).toBe(3);
    expect(body.data.map((d) => d.entryId)).toEqual(['m-new', 'm-mid', 'm-old']);
  });

  it('filters by source (source_channel)', async () => {
    insertMaterial(db, { id: 'm-web', source_channel: 'web_upload' });
    insertMaterial(db, { id: 'm-feishu', source_channel: 'feishu' });

    const mod = await import('../../app/api/pending/list/route');
    const res = await mod.GET(makeGet('?source=feishu'));
    const body = (await res.json()) as { data: Array<{ entryId: string }>; meta: { total: number } };

    expect(body.meta.total).toBe(1);
    expect(body.data[0]?.entryId).toBe('m-feishu');
  });

  it('filters by subject_hint matching suggested_subject_name', async () => {
    insertMaterial(db, { id: 'm-prob', suggested_subject_name: '概率论与数理统计' });
    insertMaterial(db, { id: 'm-vid', suggested_subject_name: '视频剪辑' });

    const mod = await import('../../app/api/pending/list/route');
    const res = await mod.GET(makeGet('?subject_hint=概率'));
    const body = (await res.json()) as { data: Array<{ entryId: string }>; meta: { total: number } };

    expect(body.meta.total).toBe(1);
    expect(body.data[0]?.entryId).toBe('m-prob');
  });

  it('filters by subject_hint matching subject_nodes.name via subject_node_id', async () => {
    insertSubject(db, 'sn-prob', '概率论');
    insertSubject(db, 'sn-vid', '视频剪辑');
    insertMaterial(db, { id: 'm-a', subject_node_id: 'sn-prob' });
    insertMaterial(db, { id: 'm-b', subject_node_id: 'sn-vid' });

    const mod = await import('../../app/api/pending/list/route');
    const res = await mod.GET(makeGet('?subject_hint=概率'));
    const body = (await res.json()) as { data: Array<{ entryId: string; candidateBreadcrumb: unknown[] }>; meta: { total: number } };

    expect(body.meta.total).toBe(1);
    expect(body.data[0]?.entryId).toBe('m-a');
    expect(body.data[0]?.candidateBreadcrumb).toEqual([{ id: 'sn-prob', name: '概率论', level: 0 }]);
  });

  it('respects page / pageSize boundaries', async () => {
    for (let i = 0; i < 5; i++) {
      insertMaterial(db, {
        id: `m-${i}`,
        created_at: `2026-05-2${i}T00:00:00.000Z`,
      });
    }
    const mod = await import('../../app/api/pending/list/route');
    const res = await mod.GET(makeGet('?page=2&pageSize=2'));
    const body = (await res.json()) as { data: Array<{ entryId: string }>; meta: { total: number; page: number; pageSize: number } };

    expect(body.meta.total).toBe(5);
    expect(body.meta.page).toBe(2);
    expect(body.meta.pageSize).toBe(2);
    expect(body.data).toHaveLength(2);
    // newest-first: m-4, m-3 | m-2, m-1 | m-0  → page 2 → m-2, m-1
    expect(body.data.map((d) => d.entryId)).toEqual(['m-2', 'm-1']);
  });

  it('rejects invalid page param', async () => {
    const mod = await import('../../app/api/pending/list/route');
    const res = await mod.GET(makeGet('?page=-1'));
    expect(res.status).toBe(400);
  });
});
