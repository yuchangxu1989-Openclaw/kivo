/**
 * Pending Reject Tests — KIVO Wave 1 / C1
 * AC-PENDING-3.1：reject 写 personal_state，entry 保留 pending_review/pending_classification
 *
 * 覆盖：
 *   - reject 成功：classification_status='pending_classification'，
 *     subject_node_id / suggested_subject_name / classification_confidence 全部清空
 *   - reject 写入 personal_state（learner_id=user-default, evidence_count=1, weak_reason 含 reason）
 *   - 重复 reject → evidence_count++
 *   - candidate_subject_id 显式但不存在 → 400
 *   - entry 不存在 → 404
 *   - entry 已 classified → 409
 *   - reason 字段可省略
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
  return new NextRequest(new URL('/api/pending/reject', BASE), {
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

function insertSubject(target: Database.Database, id: string, name: string) {
  target
    .prepare(
      `INSERT INTO subject_nodes (id, parent_id, name, tree_kind, origin, created_at, level)
       VALUES (?, NULL, ?, 'subject', 'manual', ?, 0)`,
    )
    .run(id, name, Date.now());
}

function insertMaterial(
  target: Database.Database,
  id: string,
  opts: {
    classification_status?: string;
    subject_node_id?: string | null;
    suggested_subject_name?: string | null;
    classification_confidence?: number | null;
  } = {},
) {
  const now = new Date().toISOString();
  target
    .prepare(
      `INSERT INTO materials
        (id, file_name, mime_type, file_size, status, space_id,
         created_at, updated_at, storage_path,
         classification_status, source_channel, subject_node_id,
         suggested_subject_name, classification_confidence)
       VALUES (?, ?, 'application/pdf', 1024, 'processing', 'default',
               ?, ?, ?, ?, 'web_upload', ?, ?, ?)`,
    )
    .run(
      id,
      `${id}.pdf`,
      now,
      now,
      `/tmp/${id}.pdf`,
      opts.classification_status ?? 'needs_review',
      opts.subject_node_id ?? null,
      opts.suggested_subject_name ?? null,
      opts.classification_confidence ?? null,
    );
}

beforeAll(() => {
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'kivo-pending-reject-')), 'kivo.db');
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

describe('POST /api/pending/reject', () => {
  it('clears suggestion fields, requeues, and writes personal_state', async () => {
    insertSubject(db, 'sn-1', '概率论');
    insertMaterial(db, 'm-1', {
      classification_status: 'needs_review',
      subject_node_id: 'sn-1',
      suggested_subject_name: '概率论',
      classification_confidence: 0.42,
    });

    const mod = await import('../../app/api/pending/reject/route');
    const res = await mod.POST(
      makePost({ entry_id: 'm-1', candidate_subject_id: 'sn-1', reason: '主题不符' }),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { entryId: string; classificationStatus: string; personalStateUpdated: boolean } };
    expect(body.data).toEqual({
      entryId: 'm-1',
      classificationStatus: 'pending_classification',
      personalStateUpdated: true,
    });

    const row = db
      .prepare(
        `SELECT classification_status, subject_node_id, suggested_subject_name,
                classification_confidence
           FROM materials WHERE id = 'm-1'`,
      )
      .get() as {
        classification_status: string;
        subject_node_id: string | null;
        suggested_subject_name: string | null;
        classification_confidence: number | null;
      };
    expect(row.classification_status).toBe('pending_classification');
    expect(row.subject_node_id).toBeNull();
    expect(row.suggested_subject_name).toBeNull();
    expect(row.classification_confidence).toBeNull();

    const ps = db
      .prepare(
        `SELECT learner_id, entry_id, evidence_count, weak_reason, last_seen
           FROM personal_state WHERE learner_id = 'user-default' AND entry_id = 'm-1'`,
      )
      .get() as { learner_id: string; entry_id: string; evidence_count: number; weak_reason: string; last_seen: number };
    expect(ps).toBeDefined();
    expect(ps.evidence_count).toBe(1);
    expect(ps.weak_reason).toContain('reject:m-1');
    expect(ps.weak_reason).toContain('candidate=sn-1');
    expect(ps.weak_reason).toContain('name=概率论');
    expect(ps.weak_reason).toContain('reason=主题不符');
    expect(typeof ps.last_seen).toBe('number');
  });

  it('increments evidence_count on repeated rejects', async () => {
    insertSubject(db, 'sn-1', '概率论');
    insertMaterial(db, 'm-1', {
      classification_status: 'needs_review',
      subject_node_id: 'sn-1',
      suggested_subject_name: '概率论',
    });

    const mod = await import('../../app/api/pending/reject/route');
    await mod.POST(makePost({ entry_id: 'm-1', candidate_subject_id: 'sn-1' }));

    // simulate A2 re-suggesting
    db.prepare(
      `UPDATE materials SET classification_status='needs_review',
              subject_node_id='sn-1', suggested_subject_name='概率论'
        WHERE id='m-1'`,
    ).run();

    await mod.POST(makePost({ entry_id: 'm-1', candidate_subject_id: 'sn-1', reason: '再次拒绝' }));

    const ps = db
      .prepare(
        `SELECT evidence_count, weak_reason FROM personal_state
          WHERE learner_id='user-default' AND entry_id='m-1'`,
      )
      .get() as { evidence_count: number; weak_reason: string };
    expect(ps.evidence_count).toBe(2);
    expect(ps.weak_reason).toContain('reason=再次拒绝');
  });

  it('works without explicit candidate_subject_id by reading suggestion from row', async () => {
    insertSubject(db, 'sn-1', '概率论');
    insertMaterial(db, 'm-1', {
      classification_status: 'needs_review',
      subject_node_id: 'sn-1',
      suggested_subject_name: '概率论',
    });

    const mod = await import('../../app/api/pending/reject/route');
    const res = await mod.POST(makePost({ entry_id: 'm-1' }));
    expect(res.status).toBe(200);

    const ps = db
      .prepare(
        `SELECT weak_reason FROM personal_state
          WHERE learner_id='user-default' AND entry_id='m-1'`,
      )
      .get() as { weak_reason: string };
    expect(ps.weak_reason).toContain('candidate=sn-1');
  });

  it('still writes personal_state when no candidate exists at all', async () => {
    insertMaterial(db, 'm-1', { classification_status: 'pending' });

    const mod = await import('../../app/api/pending/reject/route');
    const res = await mod.POST(makePost({ entry_id: 'm-1', reason: '太杂了' }));
    expect(res.status).toBe(200);

    const ps = db
      .prepare(
        `SELECT weak_reason, evidence_count FROM personal_state
          WHERE learner_id='user-default' AND entry_id='m-1'`,
      )
      .get() as { weak_reason: string; evidence_count: number };
    expect(ps.evidence_count).toBe(1);
    expect(ps.weak_reason).toContain('reason=太杂了');
    expect(ps.weak_reason).not.toContain('candidate=');
  });

  it('returns 404 when entry does not exist', async () => {
    const mod = await import('../../app/api/pending/reject/route');
    const res = await mod.POST(makePost({ entry_id: 'ghost' }));
    expect(res.status).toBe(404);
  });

  it('returns 409 when entry is already classified', async () => {
    insertSubject(db, 'sn-1', '概率论');
    insertMaterial(db, 'm-1', {
      classification_status: 'classified',
      subject_node_id: 'sn-1',
    });

    const mod = await import('../../app/api/pending/reject/route');
    const res = await mod.POST(makePost({ entry_id: 'm-1' }));
    expect(res.status).toBe(409);
  });

  it('returns 400 when explicit candidate_subject_id does not exist', async () => {
    insertMaterial(db, 'm-1', { classification_status: 'pending' });
    const mod = await import('../../app/api/pending/reject/route');
    const res = await mod.POST(
      makePost({ entry_id: 'm-1', candidate_subject_id: 'sn-ghost' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when body missing entry_id', async () => {
    const mod = await import('../../app/api/pending/reject/route');
    const res = await mod.POST(makePost({}));
    expect(res.status).toBe(400);
  });
});
