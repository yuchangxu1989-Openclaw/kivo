import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureMaterialsTable } from '../../lib/wiki-materials-store';

const BASE = 'http://localhost:3000';

function makePost(pathname: string, body: unknown): NextRequest {
  return new NextRequest(new URL(pathname, BASE), {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kivo-entry-subject-'));
  const dbPath = path.join(dir, 'kivo.db');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE subject_nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      tree_kind TEXT NOT NULL DEFAULT 'subject',
      origin TEXT NOT NULL DEFAULT 'manual',
      created_by_material_id TEXT,
      created_at INTEGER NOT NULL,
      confidence REAL,
      aliases TEXT,
      merged_into TEXT,
      level INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active'
    );
  `);
  ensureMaterialsTable(db);

  return { dir, dbPath, db };
}

function seedSubject(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO subject_nodes
       (id, parent_id, name, tree_kind, origin, created_at, level, status)
     VALUES (?, NULL, ?, 'subject', 'manual', ?, 0, 'active')`,
  ).run(id, id, Date.now());
}

function seedMaterial(
  db: Database.Database,
  input: { id: string; subjectNodeId: string | null; classificationStatus?: string },
): void {
  db.prepare(`
    INSERT INTO materials (
      id, file_name, mime_type, file_size, status, space_id, wiki_page_count,
      created_at, updated_at, storage_path, wiki_page_ids_json, error_message,
      classification_status, asset_kind, source_channel, source_ref, subject_node_id
    ) VALUES (?, ?, 'text/plain', 1, 'processing', 'default', 0,
      ?, ?, '', '[]', NULL, ?, 'text', 'api', ?, ?)
  `).run(
    input.id,
    `${input.id}.txt`,
    new Date().toISOString(),
    new Date().toISOString(),
    input.classificationStatus ?? 'classified',
    `api://material/${input.id}`,
    input.subjectNodeId,
  );
}

describe('B-class entry extraction subject propagation', () => {
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

  it('writes entries.subject_id from the classified source material subject_node_id', async () => {
    seedSubject(ctx.db, 'subject-math');
    seedMaterial(ctx.db, { id: 'material-classified', subjectNodeId: 'subject-math' });

    const { POST } = await import('../../app/api/v1/knowledge/route');
    const res = await POST(makePost('/api/v1/knowledge', {
      title: '代数材料提取规则',
      content: '分类完成的代数材料在 B 类提取时应继承素材所属学科。',
      type: 'fact',
      sourceMaterialId: 'material-classified',
      sourceDocument: 'material-classified.txt',
      confidence: 0.95,
    }));

    expect(res.status).toBe(201);
    const body = await json<{ data: { id: string; subjectId?: string } }>(res);
    expect(body.data.subjectId).toBe('subject-math');

    const entry = ctx.db
      .prepare(`SELECT subject_id, source_json, metadata_json FROM entries WHERE id = ?`)
      .get(body.data.id) as { subject_id: string | null; source_json: string; metadata_json: string | null };
    expect(entry.subject_id).toBe('subject-math');
    expect(JSON.parse(entry.source_json).materialId).toBe('material-classified');
    expect(JSON.parse(entry.metadata_json ?? '{}').domainData.sourceMaterialId).toBe('material-classified');
  }, 15_000);

  it('leaves entries.subject_id null when the source material has no subject_node_id yet', async () => {
    seedMaterial(ctx.db, {
      id: 'material-unclassified',
      subjectNodeId: null,
      classificationStatus: 'pending',
    });

    const { POST } = await import('../../app/api/v1/knowledge/route');
    const res = await POST(makePost('/api/v1/knowledge', {
      title: '未分类材料提取规则',
      content: '未完成 A2 分类的素材在 B 类提取时不应伪造学科归属。',
      type: 'fact',
      materialId: 'material-unclassified',
      confidence: 0.95,
    }));

    expect(res.status).toBe(201);
    const body = await json<{ data: { id: string; subjectId?: string } }>(res);
    expect(body.data.subjectId).toBeUndefined();

    const entry = ctx.db
      .prepare(`SELECT subject_id FROM entries WHERE id = ?`)
      .get(body.data.id) as { subject_id: string | null };
    expect(entry.subject_id).toBeNull();
  }, 15_000);
});
