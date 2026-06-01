import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const BASE = 'http://localhost:3000';
const TEST_DB_DIR = mkdtempSync(path.join(tmpdir(), 'kivo-intent-legacy-'));
const DB_PATH = path.join(TEST_DB_DIR, 'kivo.db');

function makeGet(urlPath: string): NextRequest {
  return new NextRequest(new URL(urlPath, BASE));
}

describe('legacy intent entries fallback', () => {
  beforeAll(() => {
    process.env.KIVO_DB_PATH = DB_PATH;
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        source_json TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active',
        tags_json TEXT NOT NULL DEFAULT '[]',
        domain TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        supersedes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        similar_sentences TEXT DEFAULT '[]',
        nature TEXT,
        function_tag TEXT,
        knowledge_domain TEXT,
        metadata_json TEXT,
        embedding BLOB,
        content_hash TEXT,
        last_hit_at TEXT,
        parent_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT
      );
    `);
    db.prepare(`
      INSERT INTO entries (id, type, title, content, summary, status, confidence, created_at, updated_at, similar_sentences, source_json)
      VALUES (?, 'intent', ?, ?, ?, 'active', 1.0, ?, ?, ?, '{}')
    `).run(
      'ke-011',
      '用户偏好：先执行后汇报',
      '用户明确要求先执行后汇报，做完再说怎么做的。',
      '用户明确要求先执行后汇报，做完再说怎么做的。',
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '["先干再汇报"]',
    );
    db.close();
  });

  afterAll(() => {
    delete process.env.KIVO_DB_PATH;
    rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  it('lists legacy intent entries when intents table is empty', async () => {
    vi.resetModules();
    const mod = await import('../../app/api/v1/intents/route');
    const res = await mod.GET(makeGet('/api/v1/intents'));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { items: Array<{ id: string; name: string; description: string }> } };
    expect(body.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ke-011',
          name: '用户偏好：先执行后汇报',
          description: '用户明确要求先执行后汇报，做完再说怎么做的。',
        }),
      ]),
    );
  });

  it('returns legacy intent detail by id', async () => {
    vi.resetModules();
    const mod = await import('../../app/api/v1/intents/route');
    const res = await mod.GET(makeGet('/api/v1/intents?id=ke-011'));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; similarSentences: string[] } };
    expect(body.data.id).toBe('ke-011');
    expect(body.data.similarSentences).toContain('先干再汇报');
  });
});
