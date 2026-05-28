import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureMaterialsTable } from '../../lib/wiki-materials-store';

const BASE = 'http://localhost:3000';

function makePost(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/v1/knowledge', BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

interface TestContext {
  dir: string;
  dbPath: string;
  db: Database.Database;
}

function createContext(): TestContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kivo-knowledge-subject-'));
  const dbPath = path.join(dir, 'kivo.db');
  const db = new Database(dbPath);
  ensureMaterialsTable(db);
  return { dir, dbPath, db };
}

function seedMaterial(db: Database.Database, id: string, subjectNodeId: string | null): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO materials (
      id, file_name, mime_type, file_size, status, space_id, wiki_page_count,
      created_at, updated_at, storage_path, wiki_page_ids_json, error_message,
      classification_status, asset_kind, source_channel, source_ref, subject_node_id
    ) VALUES (?, ?, 'application/pdf', 1, 'done', 'default', 1,
      ?, ?, '', '[]', NULL, ?, 'document', 'api', ?, ?)
  `).run(
    id,
    `${id}.pdf`,
    now,
    now,
    subjectNodeId ? 'classified' : 'pending',
    `api://material/${id}`,
    subjectNodeId,
  );
}

async function postEntry(body: Record<string, unknown>, suffix: string) {
  const { POST } = await import('../../app/api/v1/knowledge/route');
  const res = await POST(makePost({
    title: `FR-B03 AC7 ${suffix}`,
    content: `FR-B03 AC7 subject inheritance test content ${suffix}`,
    type: 'fact',
    confidence: 0.95,
    ...body,
  }));

  expect(res.status).toBe(201);
  return json<{ data: { id: string; subjectId?: string } }>(res);
}

describe('POST /api/v1/knowledge subject inheritance (FR-B03 AC7)', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createContext();
    process.env.KIVO_DB_PATH = ctx.dbPath;
    vi.resetModules();
  });

  afterEach(() => {
    ctx.db.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
    delete process.env.KIVO_DB_PATH;
    vi.resetModules();
  });

  it('inherits entries.subject_id from sourceMaterialId', async () => {
    seedMaterial(ctx.db, 'material-source-direct', 'subj-A');

    const body = await postEntry({ sourceMaterialId: 'material-source-direct' }, 'sourceMaterialId');

    expect(body.data.subjectId).toBe('subj-A');
    const row = ctx.db
      .prepare(`SELECT subject_id, source_json FROM entries WHERE id = ?`)
      .get(body.data.id) as { subject_id: string | null; source_json: string };
    expect(row.subject_id).toBe('subj-A');
    expect(JSON.parse(row.source_json).materialId).toBe('material-source-direct');
  });

  it('inherits entries.subject_id from nested source.materialId', async () => {
    seedMaterial(ctx.db, 'material-source-nested', 'subj-B');

    const body = await postEntry({ source: { materialId: 'material-source-nested' } }, 'nested materialId');

    expect(body.data.subjectId).toBe('subj-B');
    const row = ctx.db
      .prepare(`SELECT subject_id, source_json FROM entries WHERE id = ?`)
      .get(body.data.id) as { subject_id: string | null; source_json: string };
    expect(row.subject_id).toBe('subj-B');
    expect(JSON.parse(row.source_json).materialId).toBe('material-source-nested');
  });

  it('keeps entries.subject_id null when no material id is provided', async () => {
    const body = await postEntry({}, 'no material id');

    expect(body.data.subjectId).toBeUndefined();
    const row = ctx.db
      .prepare(`SELECT subject_id FROM entries WHERE id = ?`)
      .get(body.data.id) as { subject_id: string | null };
    expect(row.subject_id).toBeNull();
  });

  it('keeps entries.subject_id null when the source material is unclassified', async () => {
    seedMaterial(ctx.db, 'material-unclassified', null);

    const body = await postEntry({ materialId: 'material-unclassified' }, 'unclassified material');

    expect(body.data.subjectId).toBeUndefined();
    const row = ctx.db
      .prepare(`SELECT subject_id, source_json FROM entries WHERE id = ?`)
      .get(body.data.id) as { subject_id: string | null; source_json: string };
    expect(row.subject_id).toBeNull();
    expect(JSON.parse(row.source_json).materialId).toBe('material-unclassified');
  });
});
