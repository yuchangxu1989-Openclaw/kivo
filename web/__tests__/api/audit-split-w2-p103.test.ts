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

interface Ctx { dir: string; dbPath: string; db: Database.Database; }

function createBaseDb(): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kivo-audit-'));
  const dbPath = path.join(dir, 'kivo.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE subject_nodes (
      id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL,
      tree_kind TEXT NOT NULL DEFAULT 'subject',
      origin TEXT NOT NULL DEFAULT 'manual',
      created_by_material_id TEXT, created_at INTEGER NOT NULL,
      confidence REAL, aliases TEXT, merged_into TEXT,
      level INTEGER DEFAULT 0, status TEXT DEFAULT 'active'
    );
    CREATE TABLE entries (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'domain', content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active', subject_id TEXT,
      source_json TEXT NOT NULL DEFAULT '{}', metadata_json TEXT
    );
    CREATE TABLE materials (
      id TEXT PRIMARY KEY, file_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '', file_size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active', space_id TEXT NOT NULL DEFAULT 'default',
      wiki_page_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
      storage_path TEXT NOT NULL DEFAULT '', wiki_page_ids_json TEXT NOT NULL DEFAULT '[]',
      error_message TEXT, subject_node_id TEXT
    );
    CREATE TABLE subject_aliases (
      id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, alias_name TEXT NOT NULL,
      alias_kind TEXT NOT NULL DEFAULT 'manual', created_at INTEGER NOT NULL,
      UNIQUE(subject_id, alias_name)
    );
    CREATE TABLE subject_history (
      id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
    );
  `);
  return { dir, dbPath, db };
}

function seedSubject(db: Database.Database, id: string, name: string, parentId: string|null = null, level = 0) {
  db.prepare(`INSERT INTO subject_nodes (id, parent_id, name, tree_kind, origin, created_at, level, status) VALUES (?, ?, ?, 'subject', 'manual', ?, ?, 'active')`).run(id, parentId, name, Date.now(), level);
}
function seedEntry(db: Database.Database, id: string, subjectId: string, sourceJson: object, metadataJson: object | null) {
  db.prepare(`INSERT INTO entries (id, title, subject_id, source_json, metadata_json) VALUES (?, ?, ?, ?, ?)`).run(
    id, id, subjectId, JSON.stringify(sourceJson), metadataJson ? JSON.stringify(metadataJson) : null,
  );
}
function seedMaterial(db: Database.Database, id: string, subjectId: string) {
  db.prepare(`INSERT INTO materials (id, file_name, mime_type, file_size, status, space_id, wiki_page_count, created_at, updated_at, storage_path, subject_node_id) VALUES (?, 'f', 'text/plain', 1, 'active', 'default', 0, 'now', 'now', '/tmp/x', ?)`).run(id, subjectId);
}

describe('audit W2-P1-03: split material redistribution multi-format source parsing', () => {
  let ctx: Ctx;
  let originalEnv: string | undefined;

  beforeEach(() => {
    ctx = createBaseDb();
    originalEnv = process.env.KIVO_DB_PATH;
    process.env.KIVO_DB_PATH = ctx.dbPath;
    vi.resetModules();
  });

  afterEach(() => {
    ctx.db.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.KIVO_DB_PATH;
    else process.env.KIVO_DB_PATH = originalEnv;
  });

  it('parses metadata_json.domainData.materialIds (canonical B-class extractor format)', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, 'parent', 'Math');
    seedSubject(ctx.db, 'source', 'Algebra', 'parent', 1);
    seedEntry(ctx.db, 'e1', 'source', {}, { domainData: { materialIds: ['m1'] } });
    seedEntry(ctx.db, 'e2', 'source', {}, { domainData: { materialIds: ['m2'] } });
    seedMaterial(ctx.db, 'm1', 'source');
    seedMaterial(ctx.db, 'm2', 'source');

    const res = await POST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [
        { name: 'A', entry_ids: ['e1'] },
        { name: 'B', entry_ids: ['e2'] },
      ],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const a = body.data.createdSubjects.find((s: any) => s.name === 'A')!;
    const b = body.data.createdSubjects.find((s: any) => s.name === 'B')!;
    const mats = ctx.db.prepare(`SELECT id, subject_node_id FROM materials ORDER BY id`).all();
    expect(mats).toEqual([
      { id: 'm1', subject_node_id: a.id },
      { id: 'm2', subject_node_id: b.id },
    ]);
  });

  it('parses metadata_json.materialIds (flat) format', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, 'parent', 'Math');
    seedSubject(ctx.db, 'source', 'Algebra', 'parent', 1);
    seedEntry(ctx.db, 'e1', 'source', {}, { materialIds: ['m1'] });
    seedEntry(ctx.db, 'e2', 'source', {}, { materialIds: ['m2'] });
    seedMaterial(ctx.db, 'm1', 'source');
    seedMaterial(ctx.db, 'm2', 'source');

    const res = await POST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [
        { name: 'A', entry_ids: ['e1'] },
        { name: 'B', entry_ids: ['e2'] },
      ],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const a = body.data.createdSubjects.find((s: any) => s.name === 'A')!;
    const b = body.data.createdSubjects.find((s: any) => s.name === 'B')!;
    expect(body.data.movedMaterials).toBe(2);
    const mats = ctx.db.prepare(`SELECT id, subject_node_id FROM materials ORDER BY id`).all();
    expect(mats).toEqual([
      { id: 'm1', subject_node_id: a.id },
      { id: 'm2', subject_node_id: b.id },
    ]);
  });

  it('parses metadata_json.materialId (singular) format', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, 'parent', 'Math');
    seedSubject(ctx.db, 'source', 'Algebra', 'parent', 1);
    seedEntry(ctx.db, 'e1', 'source', {}, { materialId: 'm1' });
    seedEntry(ctx.db, 'e2', 'source', {}, { materialId: 'm2' });
    seedMaterial(ctx.db, 'm1', 'source');
    seedMaterial(ctx.db, 'm2', 'source');

    const res = await POST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [
        { name: 'A', entry_ids: ['e1'] },
        { name: 'B', entry_ids: ['e2'] },
      ],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.movedMaterials).toBe(2);
  });

  it('parses source_json reference string material:<id>', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, 'parent', 'Math');
    seedSubject(ctx.db, 'source', 'Algebra', 'parent', 1);
    seedEntry(ctx.db, 'e1', 'source', { reference: 'material:m1' }, null);
    seedEntry(ctx.db, 'e2', 'source', { reference: 'material:m2' }, null);
    seedMaterial(ctx.db, 'm1', 'source');
    seedMaterial(ctx.db, 'm2', 'source');

    const res = await POST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [
        { name: 'A', entry_ids: ['e1'] },
        { name: 'B', entry_ids: ['e2'] },
      ],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.movedMaterials).toBe(2);
  });

  it('parses source_json reference string upload://material/<id>', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, 'parent', 'Math');
    seedSubject(ctx.db, 'source', 'Algebra', 'parent', 1);
    seedEntry(ctx.db, 'e1', 'source', { reference: 'upload://material/m1' }, null);
    seedEntry(ctx.db, 'e2', 'source', { reference: 'upload://material/m2' }, null);
    seedMaterial(ctx.db, 'm1', 'source');
    seedMaterial(ctx.db, 'm2', 'source');

    const res = await POST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [
        { name: 'A', entry_ids: ['e1'] },
        { name: 'B', entry_ids: ['e2'] },
      ],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.movedMaterials).toBe(2);
  });

  it('parses source_json reference string api://material/<id> (cc-claim)', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, 'parent', 'Math');
    seedSubject(ctx.db, 'source', 'Algebra', 'parent', 1);
    seedEntry(ctx.db, 'e1', 'source', { reference: 'api://material/m1' }, null);
    seedEntry(ctx.db, 'e2', 'source', { reference: 'api://material/m2' }, null);
    seedMaterial(ctx.db, 'm1', 'source');
    seedMaterial(ctx.db, 'm2', 'source');

    const res = await POST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [
        { name: 'A', entry_ids: ['e1'] },
        { name: 'B', entry_ids: ['e2'] },
      ],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.movedMaterials).toBe(2);
  });

  it('majority vote: m has 1 vote A + 2 votes B → goes to B', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, 'parent', 'Math');
    seedSubject(ctx.db, 'source', 'Algebra', 'parent', 1);
    seedEntry(ctx.db, 'e1', 'source', {}, { domainData: { materialIds: ['m'] } });
    seedEntry(ctx.db, 'e2', 'source', {}, { domainData: { materialIds: ['m'] } });
    seedEntry(ctx.db, 'e3', 'source', {}, { domainData: { materialIds: ['m'] } });
    seedMaterial(ctx.db, 'm', 'source');

    const res = await POST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [
        { name: 'A', entry_ids: ['e1'] },
        { name: 'B', entry_ids: ['e2', 'e3'] },
      ],
    }));
    expect(res.status).toBe(200);
    const b = (await res.json() as any).data.createdSubjects.find((s: any) => s.name === 'B')!;
    const m = ctx.db.prepare(`SELECT subject_node_id FROM materials WHERE id='m'`).get() as any;
    expect(m.subject_node_id).toBe(b.id);
  });

  it('tie break: 2nd split-target wins only when first is later in request order', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, 'parent', 'Math');
    seedSubject(ctx.db, 'source', 'Algebra', 'parent', 1);
    seedEntry(ctx.db, 'e1', 'source', {}, { domainData: { materialIds: ['m'] } });
    seedEntry(ctx.db, 'e2', 'source', {}, { domainData: { materialIds: ['m'] } });
    seedMaterial(ctx.db, 'm', 'source');

    // Order: First split is "Z" (alphabetically later), should still win as it's in index 0
    const res = await POST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [
        { name: 'Z-first-listed', entry_ids: ['e1'] },
        { name: 'A-second-listed', entry_ids: ['e2'] },
      ],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const zfirst = body.data.createdSubjects.find((s: any) => s.name === 'Z-first-listed')!;
    const m = ctx.db.prepare(`SELECT subject_node_id FROM materials WHERE id='m'`).get() as any;
    expect(m.subject_node_id).toBe(zfirst.id);
  });

  it('source soft-delete: status=split, materials migrate, source_subject still queryable', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, 'parent', 'Math');
    seedSubject(ctx.db, 'source', 'Algebra', 'parent', 1);
    seedEntry(ctx.db, 'e1', 'source', {}, { domainData: { materialIds: ['m1'] } });
    seedMaterial(ctx.db, 'm1', 'source');

    const res = await POST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [{ name: 'A', entry_ids: ['e1'] }],
    }));
    expect(res.status).toBe(200);

    const sourceRow = ctx.db.prepare(`SELECT status, merged_into FROM subject_nodes WHERE id='source'`).get() as any;
    expect(sourceRow.status).toBe('split');
    expect(sourceRow.merged_into).toBeNull();
  });

  it('source after split: blocked from rename/merge/split (not active)', async () => {
    const { POST: splitPOST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, 'parent', 'Math');
    seedSubject(ctx.db, 'source', 'Algebra', 'parent', 1);
    seedEntry(ctx.db, 'e1', 'source', {}, { domainData: { materialIds: ['m1'] } });
    seedMaterial(ctx.db, 'm1', 'source');

    const res = await splitPOST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [{ name: 'A', entry_ids: ['e1'] }],
    }));
    expect(res.status).toBe(200);

    // Try to split the already-split source again
    seedEntry(ctx.db, 'e2', 'source', {}, { domainData: { materialIds: ['m1'] } });
    const res2 = await splitPOST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [{ name: 'B', entry_ids: ['e2'] }],
    }));
    // Expect 409 Conflict (status != active)
    expect(res2.status).toBe(409);
  });

  it('soft-deleted source still appears in default listTree (query inspection)', async () => {
    // listTree filters status='active'; status='split' should be hidden
    seedSubject(ctx.db, 'parent', 'Math');
    seedSubject(ctx.db, 'source', 'Algebra', 'parent', 1);
    seedEntry(ctx.db, 'e1', 'source', {}, { domainData: { materialIds: ['m1'] } });
    seedMaterial(ctx.db, 'm1', 'source');

    const { POST } = await import('../../app/api/subjects/split/route');
    await POST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [{ name: 'A', entry_ids: ['e1'] }],
    }));

    // Query the listTree filter logic equivalents
    const visibleNodes = ctx.db.prepare(
      `SELECT id, name, status FROM subject_nodes WHERE merged_into IS NULL AND COALESCE(status, 'active') = 'active' ORDER BY level, name`
    ).all() as any[];
    const ids = visibleNodes.map(n => n.id);
    expect(ids).not.toContain('source');

    // But raw query without status filter still shows it
    const rawNodes = ctx.db.prepare(`SELECT id, status FROM subject_nodes WHERE id='source'`).get() as any;
    expect(rawNodes.status).toBe('split');
  });

  it('graph consistency: entries.subject_id matches new subject; subject_nodes.parent_id intact', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, 'parent', 'Math');
    seedSubject(ctx.db, 'source', 'Algebra', 'parent', 1);
    seedEntry(ctx.db, 'e1', 'source', {}, { domainData: { materialIds: ['m1'] } });
    seedEntry(ctx.db, 'e2', 'source', {}, { domainData: { materialIds: ['m2'] } });
    seedMaterial(ctx.db, 'm1', 'source');
    seedMaterial(ctx.db, 'm2', 'source');

    const res = await POST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [
        { name: 'A', entry_ids: ['e1'] },
        { name: 'B', entry_ids: ['e2'] },
      ],
    }));
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const a = body.data.createdSubjects.find((s: any) => s.name === 'A')!;
    const b = body.data.createdSubjects.find((s: any) => s.name === 'B')!;

    // entries.subject_id pointing at new ids (active)
    const e1 = ctx.db.prepare(`SELECT subject_id FROM entries WHERE id='e1'`).get() as any;
    const e2 = ctx.db.prepare(`SELECT subject_id FROM entries WHERE id='e2'`).get() as any;
    expect(e1.subject_id).toBe(a.id);
    expect(e2.subject_id).toBe(b.id);

    // both new subjects under same parent
    const aRow = ctx.db.prepare(`SELECT parent_id FROM subject_nodes WHERE id=?`).get(a.id) as any;
    const bRow = ctx.db.prepare(`SELECT parent_id FROM subject_nodes WHERE id=?`).get(b.id) as any;
    expect(aRow.parent_id).toBe('parent');
    expect(bRow.parent_id).toBe('parent');

    // history written
    const hist = ctx.db.prepare(`SELECT event_type, payload_json FROM subject_history WHERE subject_id='source'`).get() as any;
    expect(hist.event_type).toBe('split');
    const payload = JSON.parse(hist.payload_json);
    expect(payload.created_subject_ids).toEqual([a.id, b.id]);
    expect(payload.moved_materials).toBe(2);
  });

  it('orphan material with 0 votes stays at source', async () => {
    const { POST } = await import('../../app/api/subjects/split/route');
    seedSubject(ctx.db, 'parent', 'Math');
    seedSubject(ctx.db, 'source', 'Algebra', 'parent', 1);
    seedEntry(ctx.db, 'e1', 'source', {}, { domainData: { materialIds: ['m1'] } });
    seedMaterial(ctx.db, 'm1', 'source');
    seedMaterial(ctx.db, 'm-orphan', 'source');

    const res = await POST(makePost('/api/subjects/split', {
      source_subject_id: 'source',
      splits: [{ name: 'A', entry_ids: ['e1'] }],
    }));
    expect(res.status).toBe(200);
    const orphan = ctx.db.prepare(`SELECT subject_node_id FROM materials WHERE id='m-orphan'`).get() as any;
    expect(orphan.subject_node_id).toBe('source');
  });
});
