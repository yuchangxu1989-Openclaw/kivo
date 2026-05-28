import { describe, expect, it, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SubjectAliasRepository } from '../../lib/subjects/alias-repository';

const BASE = 'http://localhost:3000';
const ROUTE_SUBJECT_ID = 'route-subject-1';

function makeDb(file = ':memory:') {
  const db = new Database(file);
  db.exec(`
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
    INSERT INTO subject_nodes (id, parent_id, name, tree_kind, origin, created_at, level)
    VALUES ('subject-1', NULL, '概率论', 'subject', 'manual', 1, 0);
  `);
  return db;
}

function makeGet(subjectId: string): NextRequest {
  return new NextRequest(new URL(`/api/subjects/aliases?subject_id=${subjectId}`, BASE));
}

function makePost(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/subjects/aliases', BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDelete(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/subjects/aliases', BASE), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('SubjectAliasRepository', () => {
  it('creates aliases and enforces uniqueness inside the same subject', () => {
    const repo = new SubjectAliasRepository({ db: makeDb() });

    const created = repo.create('subject-1', '  伯努利试验  ');

    expect(created.subjectId).toBe('subject-1');
    expect(created.alias).toBe('伯努利试验');
    expect(repo.list('subject-1')).toHaveLength(1);
    expect(() => repo.create('subject-1', '伯努利试验')).toThrow(/already exists/);
  });

  it('lists aliases by subject and removes only existing aliases', () => {
    const repo = new SubjectAliasRepository({ db: makeDb() });
    const created = repo.create('subject-1', '随机变量');

    expect(repo.list('subject-1').map((item) => item.alias)).toEqual(['随机变量']);
    expect(repo.remove('subject-1', created.id).alias).toBe('随机变量');
    expect(repo.list('subject-1')).toEqual([]);
    expect(() => repo.remove('subject-1', created.id)).toThrow(/not found/);
  });
});

describe('/api/subjects/aliases route', () => {
  beforeAll(() => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'kivo-alias-route-')), 'kivo.db');
    const db = makeDb(dbPath);
    db.prepare(
      `INSERT INTO subject_nodes (id, parent_id, name, tree_kind, origin, created_at, level)
       VALUES (?, NULL, ?, 'subject', 'manual', ?, 0)`,
    ).run(ROUTE_SUBJECT_ID, '路线测试学科', Date.now());
    db.close();
    process.env.KIVO_DB_PATH = dbPath;
  });

  it('POST creates an alias endpoint response', async () => {
    const mod = await import('../../app/api/subjects/aliases/route');
    const res = await mod.POST(
      makePost({ subject_id: ROUTE_SUBJECT_ID, alias: '路线旧名称' }),
    );

    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string; subjectId: string; alias: string } };
    expect(body.data.id).toBeTruthy();
    expect(body.data.subjectId).toBe(ROUTE_SUBJECT_ID);
    expect(body.data.alias).toBe('路线旧名称');
  });

  it('GET lists aliases by subject_id endpoint filter', async () => {
    const mod = await import('../../app/api/subjects/aliases/route');
    const res = await mod.GET(makeGet(ROUTE_SUBJECT_ID));

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ alias: string }>; meta: { total: number } };
    expect(body.data.some((item) => item.alias === '路线旧名称')).toBe(true);
    expect(body.meta.total).toBeGreaterThanOrEqual(1);
  });

  it('DELETE removes an existing alias and reports missing aliases', async () => {
    const mod = await import('../../app/api/subjects/aliases/route');
    const created = await mod.POST(
      makePost({ subject_id: ROUTE_SUBJECT_ID, alias: '可删除旧名' }),
    );
    const createdBody = await created.json() as { data: { id: string } };

    const removed = await mod.DELETE(
      makeDelete({ subject_id: ROUTE_SUBJECT_ID, alias_id: createdBody.data.id }),
    );
    expect(removed.status).toBe(200);

    const missing = await mod.DELETE(
      makeDelete({ subject_id: ROUTE_SUBJECT_ID, alias_id: createdBody.data.id }),
    );
    expect(missing.status).toBe(404);
  });

  it('GET validates subject_id', async () => {
    const mod = await import('../../app/api/subjects/aliases/route');
    const res = await mod.GET(new NextRequest(new URL('/api/subjects/aliases', BASE)));

    expect(res.status).toBe(400);
  });
});
