/**
 * Pending Accept Tests — KIVO Wave 1 / C1
 * AC-PENDING-2.1：accept 写 entries.subject_id + status='classified'
 *
 * 注：本路 contract 中 "entry" = materials 表的一行。covers:
 *   - 接受成功：classification_status='classified'，subject_node_id=指定值
 *   - entry 不存在 → 404
 *   - subject 不存在 → 400
 *   - subject 已被合并 → 400
 *   - entry 已 classified → 409
 *   - body 缺字段 → 400
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

function makePost(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/pending/accept', BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

function insertSubject(target: Database.Database, id: string, name: string, mergedInto: string | null = null) {
  target
    .prepare(
      `INSERT INTO subject_nodes (id, parent_id, name, tree_kind, origin, created_at, level, merged_into)
       VALUES (?, NULL, ?, 'subject', 'manual', ?, 0, ?)`,
    )
    .run(id, name, Date.now(), mergedInto);
}

function insertMaterial(target: Database.Database, id: string, status = 'pending', subjectNodeId: string | null = null) {
  const now = new Date().toISOString();
  target
    .prepare(
      `INSERT INTO materials
        (id, file_name, mime_type, file_size, status, space_id,
         created_at, updated_at, storage_path,
         classification_status, source_channel, subject_node_id)
       VALUES (?, ?, 'application/pdf', 1024, 'processing', 'default',
               ?, ?, ?, ?, 'web_upload', ?)`,
    )
    .run(id, `${id}.pdf`, now, now, `/tmp/${id}.pdf`, status, subjectNodeId);
}

beforeAll(() => {
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'kivo-pending-accept-')), 'kivo.db');
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

describe('POST /api/pending/accept', () => {
  it('accepts a candidate and pins the entry to subject_id', async () => {
    insertSubject(db, 'sn-1', '概率论');
    insertMaterial(db, 'm-1', 'needs_review');

    const mod = await import('../../app/api/pending/accept/route');
    const res = await mod.POST(makePost({ entry_id: 'm-1', subject_id: 'sn-1' }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { entryId: string; subjectId: string; classificationStatus: string } };
    expect(body.data).toEqual({
      entryId: 'm-1',
      subjectId: 'sn-1',
      classificationStatus: 'classified',
    });

    const row = db
      .prepare(
        `SELECT classification_status, subject_node_id FROM materials WHERE id = 'm-1'`,
      )
      .get() as { classification_status: string; subject_node_id: string };
    expect(row.classification_status).toBe('classified');
    expect(row.subject_node_id).toBe('sn-1');
  });

  it('returns 404 when entry does not exist', async () => {
    insertSubject(db, 'sn-1', '概率论');
    const mod = await import('../../app/api/pending/accept/route');
    const res = await mod.POST(makePost({ entry_id: 'ghost', subject_id: 'sn-1' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 when subject does not exist', async () => {
    insertMaterial(db, 'm-1');
    const mod = await import('../../app/api/pending/accept/route');
    const res = await mod.POST(makePost({ entry_id: 'm-1', subject_id: 'sn-ghost' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when subject has been merged away', async () => {
    insertSubject(db, 'sn-old', '旧学科', 'sn-new');
    insertSubject(db, 'sn-new', '新学科');
    insertMaterial(db, 'm-1');

    const mod = await import('../../app/api/pending/accept/route');
    const res = await mod.POST(makePost({ entry_id: 'm-1', subject_id: 'sn-old' }));
    expect(res.status).toBe(400);
  });

  it('returns 409 when entry is already classified', async () => {
    insertSubject(db, 'sn-1', '概率论');
    insertMaterial(db, 'm-1', 'classified', 'sn-1');

    const mod = await import('../../app/api/pending/accept/route');
    const res = await mod.POST(makePost({ entry_id: 'm-1', subject_id: 'sn-1' }));
    expect(res.status).toBe(409);
  });

  it('returns 400 when body is missing required fields', async () => {
    const mod = await import('../../app/api/pending/accept/route');

    expect((await mod.POST(makePost({}))).status).toBe(400);
    expect((await mod.POST(makePost({ entry_id: 'm-1' }))).status).toBe(400);
    expect((await mod.POST(makePost({ subject_id: 'sn-1' }))).status).toBe(400);
    expect((await mod.POST(makePost({ entry_id: '   ', subject_id: 'sn-1' }))).status).toBe(400);
  });

  it('returns 400 when body is not valid JSON', async () => {
    const req = new NextRequest(new URL('/api/pending/accept', BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const mod = await import('../../app/api/pending/accept/route');
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
  });
});
