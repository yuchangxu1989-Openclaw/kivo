import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

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

function createBaseDb(): TestContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kivo-subjects-'));
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

    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'domain',
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      subject_id TEXT,
      source_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT
    );

    CREATE TABLE materials (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      space_id TEXT NOT NULL DEFAULT 'default',
      wiki_page_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      storage_path TEXT NOT NULL DEFAULT '',
      wiki_page_ids_json TEXT NOT NULL DEFAULT '[]',
      error_message TEXT,
      subject_node_id TEXT
    );

    CREATE TABLE subject_aliases (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      alias_name TEXT NOT NULL,
      alias_kind TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL,
      UNIQUE(subject_id, alias_name)
    );

    CREATE TABLE subject_history (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
  `);

  return { dir, dbPath, db };
}

function seedSubject(
  db: Database.Database,
  input: { id: string; name: string; parentId?: string | null; level?: number; status?: string },
) {
  db.prepare(
    `INSERT INTO subject_nodes
       (id, parent_id, name, tree_kind, origin, created_at, level, status)
     VALUES (?, ?, ?, 'subject', 'manual', ?, ?, ?)`,
  ).run(
    input.id,
    input.parentId ?? null,
    input.name,
    Date.now(),
    input.level ?? 0,
    input.status ?? 'active',
  );
}

function seedEntry(db: Database.Database, id: string, subjectId: string, materialIds: string[] = []) {
  db.prepare(
    `INSERT INTO entries (id, title, subject_id, source_json, metadata_json) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    subjectId,
    materialIds.length > 0 ? JSON.stringify({ materialIds }) : '{}',
    materialIds.length > 0 ? JSON.stringify({ domainData: { materialIds } }) : null,
  );
}

function seedMaterial(db: Database.Database, id: string, subjectId: string) {
  db.prepare(
    `INSERT INTO materials
       (id, file_name, mime_type, file_size, status, space_id, wiki_page_count, created_at, updated_at, storage_path, subject_node_id)
     VALUES (?, 'f', 'text/plain', 1, 'active', 'default', 0, 'now', 'now', '/tmp/x', ?)`,
  ).run(id, subjectId);
}

describe('subject mutation routes', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createBaseDb();
    process.env.KIVO_DB_PATH = ctx.dbPath;
    vi.resetModules();
  });

  afterEach(() => {
    ctx.db.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
    delete process.env.KIVO_DB_PATH;
    vi.resetModules();
  });

  it('rename route renames subject, preserves entry reference, and writes alias/history', async () => {
    const { POST } = await import('../../app/api/subjects/rename/route');
    seedSubject(ctx.db, { id: 's-math', name: 'Math' });
    seedSubject(ctx.db, { id: 's-physics', name: 'Physics' });
    seedEntry(ctx.db, 'e-1', 's-math');

    const res = await POST(
      makePost('/api/subjects/rename', {
        subject_id: 's-math',
        new_name: 'Mathematics',
      }),
    );

    expect(res.status).toBe(200);
    const body = await json<{ data: { id: string; name: string } }>(res);
    expect(body.data.id).toBe('s-math');
    expect(body.data.name).toBe('Mathematics');

    const subject = ctx.db
      .prepare(`SELECT name FROM subject_nodes WHERE id = 's-math'`)
      .get() as { name: string };
    expect(subject.name).toBe('Mathematics');

    const entry = ctx.db
      .prepare(`SELECT subject_id FROM entries WHERE id = 'e-1'`)
      .get() as { subject_id: string };
    expect(entry.subject_id).toBe('s-math');

    const alias = ctx.db
      .prepare(`SELECT alias_name FROM subject_aliases WHERE subject_id = 's-math'`)
      .get() as { alias_name: string };
    expect(alias.alias_name).toBe('Math');

    const history = ctx.db
      .prepare(`SELECT event_type FROM subject_history WHERE subject_id = 's-math'`)
      .get() as { event_type: string };
    expect(history.event_type).toBe('rename');
  });

  it('rename route returns 409 for duplicate sibling name', async () => {
    const { POST } = await import('../../app/api/subjects/rename/route');
    seedSubject(ctx.db, { id: 's-math', name: 'Math' });
    seedSubject(ctx.db, { id: 's-physics', name: 'Physics' });

    const res = await POST(
      makePost('/api/subjects/rename', {
        subject_id: 's-math',
        new_name: 'Physics',
      }),
    );

    expect(res.status).toBe(409);
  });

  it('rename route rolls back subject name when alias insert fails', async () => {
    const { POST } = await import('../../app/api/subjects/rename/route');
    seedSubject(ctx.db, { id: 's-math', name: 'Math' });
    ctx.db.prepare(
      `INSERT INTO subject_aliases (id, subject_id, alias_name, alias_kind, created_at)
       VALUES ('a-1', 's-math', 'Math', 'manual', 1)`,
    ).run();

    const res = await POST(
      makePost('/api/subjects/rename', {
        subject_id: 's-math',
        new_name: 'Mathematics',
      }),
    );

    expect(res.status).toBe(409);
    const subject = ctx.db
      .prepare(`SELECT name FROM subject_nodes WHERE id = 's-math'`)
      .get() as { name: string };
    expect(subject.name).toBe('Math');

    const historyCount = ctx.db
      .prepare(`SELECT COUNT(*) AS count FROM subject_history WHERE subject_id = 's-math'`)
      .get() as { count: number };
    expect(historyCount.count).toBe(0);
  });

  it('merge route moves entries, aliases, materials, children, and soft deletes sources', async () => {
    const { POST } = await import('../../app/api/subjects/merge/route');
    seedSubject(ctx.db, { id: 'target', name: 'Algebra' });
    seedSubject(ctx.db, { id: 'source-1', name: 'Linear Algebra' });
    seedSubject(ctx.db, { id: 'source-2', name: 'Abstract Algebra' });
    seedSubject(ctx.db, { id: 'child-1', name: 'Vectors', parentId: 'source-1', level: 1 });
    seedEntry(ctx.db, 'e-1', 'source-1');
    seedEntry(ctx.db, 'e-2', 'source-2');
    seedMaterial(ctx.db, 'm-1', 'source-1');
    ctx.db.prepare(
      `INSERT INTO subject_aliases (id, subject_id, alias_name, alias_kind, created_at)
       VALUES ('alias-src', 'source-1', 'LA', 'manual', 1)`,
    ).run();

    const res = await POST(
      makePost('/api/subjects/merge', {
        source_subject_ids: ['source-1', 'source-2'],
        target_subject_id: 'target',
      }),
    );

    expect(res.status).toBe(200);
    const body = await json<{ data: { movedEntries: number; movedAliases: number } }>(res);
    expect(body.data.movedEntries).toBe(2);
    expect(body.data.movedAliases).toBeGreaterThanOrEqual(3);

    const entries = ctx.db
      .prepare(`SELECT id, subject_id FROM entries ORDER BY id`)
      .all() as Array<{ id: string; subject_id: string }>;
    expect(entries).toEqual([
      { id: 'e-1', subject_id: 'target' },
      { id: 'e-2', subject_id: 'target' },
    ]);

    const aliasSubjects = ctx.db
      .prepare(`SELECT alias_name, subject_id FROM subject_aliases ORDER BY alias_name`)
      .all() as Array<{ alias_name: string; subject_id: string }>;
    expect(aliasSubjects.some((row) => row.alias_name === 'LA' && row.subject_id === 'target')).toBe(true);
    expect(aliasSubjects.some((row) => row.alias_name === 'Linear Algebra' && row.subject_id === 'target')).toBe(true);
    expect(aliasSubjects.some((row) => row.alias_name === 'Abstract Algebra' && row.subject_id === 'target')).toBe(true);

    const mergedSources = ctx.db
      .prepare(`SELECT id, status, merged_into FROM subject_nodes WHERE id IN ('source-1', 'source-2') ORDER BY id`)
      .all() as Array<{ id: string; status: string; merged_into: string }>;
    expect(mergedSources).toEqual([
      { id: 'source-1', status: 'merged', merged_into: 'target' },
      { id: 'source-2', status: 'merged', merged_into: 'target' },
    ]);

    const child = ctx.db
      .prepare(`SELECT parent_id FROM subject_nodes WHERE id = 'child-1'`)
      .get() as { parent_id: string };
    expect(child.parent_id).toBe('target');

    const material = ctx.db
      .prepare(`SELECT subject_node_id FROM materials WHERE id = 'm-1'`)
      .get() as { subject_node_id: string };
    expect(material.subject_node_id).toBe('target');

    const historyCount = ctx.db
      .prepare(`SELECT COUNT(*) AS count FROM subject_history WHERE event_type = 'merge'`)
      .get() as { count: number };
    expect(historyCount.count).toBe(2);
  });

  it('merge route rejects target also included in source list', async () => {
    const { POST } = await import('../../app/api/subjects/merge/route');
    seedSubject(ctx.db, { id: 'target', name: 'Algebra' });

    const res = await POST(
      makePost('/api/subjects/merge', {
        source_subject_ids: ['target'],
        target_subject_id: 'target',
      }),
    );

    expect(res.status).toBe(400);
  });

  it('merge route rolls back moved entries when alias insertion conflicts', async () => {
    const { POST } = await import('../../app/api/subjects/merge/route');
    seedSubject(ctx.db, { id: 'target', name: 'Algebra' });
    seedSubject(ctx.db, { id: 'source-1', name: 'Linear Algebra' });
    seedEntry(ctx.db, 'e-1', 'source-1');
    seedMaterial(ctx.db, 'm-1', 'source-1');
    ctx.db.prepare(
      `INSERT INTO subject_aliases (id, subject_id, alias_name, alias_kind, created_at)
       VALUES ('alias-target', 'target', 'Linear Algebra', 'manual', 1)`,
    ).run();

    const res = await POST(
      makePost('/api/subjects/merge', {
        source_subject_ids: ['source-1'],
        target_subject_id: 'target',
      }),
    );

    expect(res.status).toBe(409);
    const entry = ctx.db
      .prepare(`SELECT subject_id FROM entries WHERE id = 'e-1'`)
      .get() as { subject_id: string };
    expect(entry.subject_id).toBe('source-1');

    const material = ctx.db
      .prepare(`SELECT subject_node_id FROM materials WHERE id = 'm-1'`)
      .get() as { subject_node_id: string };
    expect(material.subject_node_id).toBe('source-1');

    const source = ctx.db
      .prepare(`SELECT status FROM subject_nodes WHERE id = 'source-1'`)
      .get() as { status: string };
    expect(source.status).toBe('active');
  });

  it('split route creates subjects, reclassifies entries, redistributes materials by entry majority, and soft deletes source', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, { id: 'parent', name: 'Math', level: 0 });
    seedSubject(ctx.db, { id: 'source', name: 'Algebra', parentId: 'parent', level: 1 });
    seedEntry(ctx.db, 'e-1', 'source', ['m-majority-linear']);
    seedEntry(ctx.db, 'e-2', 'source', ['m-majority-abstract']);
    seedEntry(ctx.db, 'e-3', 'source', ['m-majority-abstract']);
    seedMaterial(ctx.db, 'm-majority-linear', 'source');
    seedMaterial(ctx.db, 'm-majority-abstract', 'source');
    seedMaterial(ctx.db, 'm-no-entries', 'source');

    const res = await POST(
      makePost('/api/subjects/split', {
        source_subject_id: 'source',
        splits: [
          { name: 'Linear Algebra', entry_ids: ['e-1'] },
          { name: 'Abstract Algebra', entry_ids: ['e-2', 'e-3'] },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const body = await json<{ data: { createdSubjects: Array<{ id: string; name: string; parentId: string | null }>; movedEntries: number; movedMaterials: number } }>(res);
    expect(body.data.createdSubjects).toHaveLength(2);
    expect(body.data.movedEntries).toBe(3);
    expect(body.data.movedMaterials).toBe(2);
    expect(body.data.createdSubjects.every((subject) => subject.parentId === 'parent')).toBe(true);

    const linear = body.data.createdSubjects.find((subject) => subject.name === 'Linear Algebra');
    const abstract = body.data.createdSubjects.find((subject) => subject.name === 'Abstract Algebra');
    expect(linear).toBeTruthy();
    expect(abstract).toBeTruthy();

    const entries = ctx.db
      .prepare(`SELECT id, subject_id FROM entries ORDER BY id`)
      .all() as Array<{ id: string; subject_id: string }>;
    expect(entries).toEqual([
      { id: 'e-1', subject_id: linear!.id },
      { id: 'e-2', subject_id: abstract!.id },
      { id: 'e-3', subject_id: abstract!.id },
    ]);

    const materials = ctx.db
      .prepare(`SELECT id, subject_node_id FROM materials ORDER BY id`)
      .all() as Array<{ id: string; subject_node_id: string }>;
    expect(materials).toEqual([
      { id: 'm-majority-abstract', subject_node_id: abstract!.id },
      { id: 'm-majority-linear', subject_node_id: linear!.id },
      { id: 'm-no-entries', subject_node_id: 'source' },
    ]);

    const source = ctx.db
      .prepare(`SELECT status FROM subject_nodes WHERE id = 'source'`)
      .get() as { status: string };
    expect(source.status).toBe('split');

    const history = ctx.db
      .prepare(`SELECT event_type, payload_json FROM subject_history WHERE subject_id = 'source'`)
      .get() as { event_type: string; payload_json: string };
    expect(history.event_type).toBe('split');
    expect(JSON.parse(history.payload_json).moved_materials).toBe(2);
  });

  it('split route breaks material vote ties by split order and keeps no-entry materials at source', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, { id: 'parent', name: 'Math', level: 0 });
    seedSubject(ctx.db, { id: 'source', name: 'Algebra', parentId: 'parent', level: 1 });
    // m-tied produces one entry in each split target -> 1 vote per side -> tiebreaker
    seedEntry(ctx.db, 'e-1', 'source', ['m-tied']);
    seedEntry(ctx.db, 'e-2', 'source', ['m-tied']);
    seedMaterial(ctx.db, 'm-tied', 'source');
    seedMaterial(ctx.db, 'm-no-entries', 'source');

    const res = await POST(
      makePost('/api/subjects/split', {
        source_subject_id: 'source',
        splits: [
          { name: 'Linear Algebra', entry_ids: ['e-1'] },
          { name: 'Abstract Algebra', entry_ids: ['e-2'] },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const body = await json<{
      data: {
        createdSubjects: Array<{ id: string; name: string }>;
        movedMaterials: number;
      };
    }>(res);
    // Tied vote moves m-tied to first split target only -> movedMaterials = 1
    expect(body.data.movedMaterials).toBe(1);
    const linear = body.data.createdSubjects.find((subject) => subject.name === 'Linear Algebra');
    expect(linear).toBeTruthy();

    const tied = ctx.db
      .prepare(`SELECT subject_node_id FROM materials WHERE id = 'm-tied'`)
      .get() as { subject_node_id: string };
    expect(tied.subject_node_id).toBe(linear!.id);

    const stayed = ctx.db
      .prepare(`SELECT subject_node_id FROM materials WHERE id = 'm-no-entries'`)
      .get() as { subject_node_id: string };
    expect(stayed.subject_node_id).toBe('source');
  });

  it('split route rejects incomplete entry coverage', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, { id: 'parent', name: 'Math', level: 0 });
    seedSubject(ctx.db, { id: 'source', name: 'Algebra', parentId: 'parent', level: 1 });
    seedEntry(ctx.db, 'e-1', 'source');
    seedEntry(ctx.db, 'e-2', 'source');

    const res = await POST(
      makePost('/api/subjects/split', {
        source_subject_id: 'source',
        splits: [{ name: 'Linear Algebra', entry_ids: ['e-1'] }],
      }),
    );

    expect(res.status).toBe(400);
  });

  it('split route rolls back created subjects and entry moves on mid-transaction failure', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, { id: 'parent', name: 'Math', level: 0 });
    seedSubject(ctx.db, { id: 'source', name: 'Algebra', parentId: 'parent', level: 1 });
    seedSubject(ctx.db, { id: 'existing', name: 'Geometry', parentId: 'parent', level: 1 });
    seedEntry(ctx.db, 'e-1', 'source');
    seedEntry(ctx.db, 'e-2', 'source');

    const res = await POST(
      makePost('/api/subjects/split', {
        source_subject_id: 'source',
        splits: [
          { name: 'Linear Algebra', entry_ids: ['e-1'] },
          { name: 'Geometry', entry_ids: ['e-2'] },
        ],
      }),
    );

    expect(res.status).toBe(409);
    const createdCount = ctx.db
      .prepare(`SELECT COUNT(*) AS count FROM subject_nodes WHERE name = 'Linear Algebra'`)
      .get() as { count: number };
    expect(createdCount.count).toBe(0);

    const entries = ctx.db
      .prepare(`SELECT subject_id FROM entries ORDER BY id`)
      .all() as Array<{ subject_id: string }>;
    expect(entries.every((row) => row.subject_id === 'source')).toBe(true);

    const source = ctx.db
      .prepare(`SELECT status FROM subject_nodes WHERE id = 'source'`)
      .get() as { status: string };
    expect(source.status).toBe('active');

    const historyCount = ctx.db
      .prepare(`SELECT COUNT(*) AS count FROM subject_history WHERE subject_id = 'source'`)
      .get() as { count: number };
    expect(historyCount.count).toBe(0);
  });
});
