/**
 * Unit tests for cron-retry-graph-pending state machine.
 *
 * 覆盖：
 *   - 默认值兜底（旧 entries 无 graphRetryCount）
 *   - retryCount 累加 + graphState='pending'
 *   - LLM 推断成功 → graphState='resolved' + 清空 graphPending + 重置 retryCount
 *   - retryCount >= 3 → graphState='abandoned'
 *   - 单条失败不阻塞下一条（异常隔离）
 *   - 50 批量 LIMIT 守门
 *   - 已 abandoned 的 entry 不再被扫描
 *
 * 署名：free-code（OpenClaw ACP Agent）/ 2026-05-24
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  runRetryPass,
  selectPendingRows,
  updateGraphRetryState,
  DEFAULT_BATCH_LIMIT,
  type ProcessFn,
} from '../cron-retry-graph-pending.js';

interface InsertEntryOptions {
  id: string;
  status?: string;
  subjectId?: string | null;
  metadata?: Record<string, unknown> | null;
  updatedAt?: string;
}

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'fact',
      title TEXT NOT NULL DEFAULT 't',
      content TEXT NOT NULL DEFAULT 'c',
      summary TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL DEFAULT '{}',
      tags_json TEXT NOT NULL DEFAULT '[]',
      domain TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      subject_id TEXT,
      metadata_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertEntry(db: Database.Database, opts: InsertEntryOptions): void {
  const subjectId = 'subjectId' in opts ? opts.subjectId : 'subject-1';
  db.prepare(
    `INSERT INTO entries (id, status, subject_id, metadata_json, updated_at)
     VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(
    opts.id,
    opts.status ?? 'active',
    subjectId ?? null,
    opts.metadata === null ? null : JSON.stringify(opts.metadata ?? {}),
    opts.updatedAt ?? null,
  );
}

function readMetadata(db: Database.Database, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT metadata_json FROM entries WHERE id = ?').get(id) as
    | { metadata_json: string | null }
    | undefined;
  if (!row?.metadata_json) return {};
  return JSON.parse(row.metadata_json);
}

function readDomain(db: Database.Database, id: string): Record<string, unknown> {
  const meta = readMetadata(db, id);
  const domain = meta.domainData;
  return domain && typeof domain === 'object' ? (domain as Record<string, unknown>) : {};
}

const successProcess: ProcessFn = async () => ({ failed: 0, edgesWritten: 2 });
const failProcess: ProcessFn = async () => ({ failed: 1, edgesWritten: 0 });
const throwProcess: ProcessFn = async () => {
  throw new Error('boom');
};

describe('cron-retry-graph-pending state machine', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  it('selectPendingRows: 旧 entries 无 graphRetryCount → 默认值 0', () => {
    insertEntry(db, {
      id: 'legacy-1',
      metadata: { domainData: { graphPending: true } },
    });
    const rows = selectPendingRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: 'legacy-1', retryCount: 0 });
  });

  it('selectPendingRows: 已 abandoned 的 entry 不再被扫描', () => {
    insertEntry(db, {
      id: 'abandoned-1',
      metadata: {
        domainData: {
          graphPending: true,
          graphRetryCount: 3,
          graphState: 'abandoned',
        },
      },
    });
    insertEntry(db, {
      id: 'pending-1',
      metadata: { domainData: { graphPending: true } },
    });
    const rows = selectPendingRows(db);
    expect(rows.map((row) => row.id).sort()).toEqual(['pending-1']);
  });

  it('selectPendingRows: 缺 subject_id 或非 active 不进入候选', () => {
    insertEntry(db, {
      id: 'no-subject',
      subjectId: null,
      metadata: { domainData: { graphPending: true } },
    });
    insertEntry(db, {
      id: 'inactive',
      status: 'archived',
      metadata: { domainData: { graphPending: true } },
    });
    insertEntry(db, {
      id: 'good',
      metadata: { domainData: { graphPending: true } },
    });
    const rows = selectPendingRows(db);
    expect(rows.map((row) => row.id)).toEqual(['good']);
  });

  it('runRetryPass: LLM 成功 → graphState=resolved + 清 graphPending + 重置 retryCount', async () => {
    insertEntry(db, {
      id: 'e1',
      metadata: {
        domainData: {
          graphPending: true,
          graphPendingReason: 'old',
          graphRetryCount: 1,
        },
      },
    });
    const stats = await runRetryPass(db, { processFn: successProcess });
    expect(stats).toMatchObject({ scanned: 1, resolved: 1, retried: 0, abandoned: 0, errors: 0 });
    expect(stats.edgesWritten).toBe(2);
    const domain = readDomain(db, 'e1');
    expect(domain.graphState).toBe('resolved');
    expect(domain.graphPending).toBeUndefined();
    expect(domain.graphPendingReason).toBeUndefined();
    expect(domain.graphRetryCount).toBeUndefined();
  });

  it('runRetryPass: LLM 失败 → retryCount 累加 + graphState=pending', async () => {
    insertEntry(db, {
      id: 'e2',
      metadata: { domainData: { graphPending: true } },
    });
    const stats = await runRetryPass(db, { processFn: failProcess });
    expect(stats).toMatchObject({ scanned: 1, resolved: 0, retried: 1, abandoned: 0 });
    const domain = readDomain(db, 'e2');
    expect(domain.graphRetryCount).toBe(1);
    expect(domain.graphState).toBe('pending');
    expect(domain.graphPending).toBe(true); // 仍可被下次 cron 扫到
  });

  it('runRetryPass: retryCount 累加到 3 → graphState=abandoned', async () => {
    insertEntry(db, {
      id: 'e3',
      metadata: { domainData: { graphPending: true, graphRetryCount: 2 } },
    });
    const stats = await runRetryPass(db, { processFn: failProcess });
    expect(stats).toMatchObject({ scanned: 1, abandoned: 1, retried: 0 });
    const domain = readDomain(db, 'e3');
    expect(domain.graphRetryCount).toBe(3);
    expect(domain.graphState).toBe('abandoned');
  });

  it('runRetryPass: 自定义 maxRetry=5 时不会过早 abandoned', async () => {
    insertEntry(db, {
      id: 'e4',
      metadata: { domainData: { graphPending: true, graphRetryCount: 2 } },
    });
    const stats = await runRetryPass(db, { processFn: failProcess, maxRetry: 5 });
    expect(stats.abandoned).toBe(0);
    expect(stats.retried).toBe(1);
    const domain = readDomain(db, 'e4');
    expect(domain.graphRetryCount).toBe(3);
    expect(domain.graphState).toBe('pending');
  });

  it('runRetryPass: 单条抛异常不阻塞后续条目', async () => {
    insertEntry(db, {
      id: 'bad',
      metadata: { domainData: { graphPending: true } },
      updatedAt: '2026-05-23 12:00:00',
    });
    insertEntry(db, {
      id: 'good',
      metadata: { domainData: { graphPending: true } },
      updatedAt: '2026-05-23 13:00:00',
    });
    let invocation = 0;
    const flakyProcess: ProcessFn = async () => {
      invocation += 1;
      if (invocation === 1) throw new Error('boom');
      return { failed: 0, edgesWritten: 1 };
    };
    const stats = await runRetryPass(db, { processFn: flakyProcess });
    expect(stats.scanned).toBe(2);
    expect(stats.errors).toBe(1);
    expect(stats.resolved).toBe(1);
    expect(readDomain(db, 'good').graphState).toBe('resolved');
  });

  it('runRetryPass: throwProcess 全异常 → errors=N，retryCount 不变', async () => {
    insertEntry(db, {
      id: 'panic',
      metadata: { domainData: { graphPending: true, graphRetryCount: 1 } },
    });
    const stats = await runRetryPass(db, { processFn: throwProcess });
    expect(stats.errors).toBe(1);
    expect(stats.resolved).toBe(0);
    expect(stats.retried).toBe(0);
    expect(readDomain(db, 'panic').graphRetryCount).toBe(1);
  });

  it('runRetryPass: LIMIT 守门 50 → 第 51 条留到下次', async () => {
    expect(DEFAULT_BATCH_LIMIT).toBe(50);
    for (let i = 0; i < 60; i += 1) {
      insertEntry(db, {
        id: `bulk-${i.toString().padStart(2, '0')}`,
        metadata: { domainData: { graphPending: true } },
        updatedAt: `2026-05-23 12:${i.toString().padStart(2, '0')}:00`,
      });
    }
    const stats = await runRetryPass(db, { processFn: successProcess });
    expect(stats.scanned).toBe(50);
    expect(stats.resolved).toBe(50);
    const remaining = selectPendingRows(db);
    expect(remaining).toHaveLength(10);
  });

  it('runRetryPass: 空表不报错 → 全 0 stats', async () => {
    const stats = await runRetryPass(db, { processFn: failProcess });
    expect(stats).toEqual({
      scanned: 0,
      resolved: 0,
      retried: 0,
      abandoned: 0,
      errors: 0,
      edgesWritten: 0,
    });
  });

  it('updateGraphRetryState: 直接调用 patch 行为正确', () => {
    insertEntry(db, {
      id: 'patchee',
      metadata: { domainData: { graphPending: true, foo: 'bar' } },
    });
    updateGraphRetryState(db, 'patchee', {
      graphState: 'resolved',
      clearPending: true,
      resetRetryCount: true,
    });
    const domain = readDomain(db, 'patchee');
    expect(domain.foo).toBe('bar'); // 其他字段保留
    expect(domain.graphPending).toBeUndefined();
    expect(domain.graphState).toBe('resolved');
    expect(domain.graphRetryCount).toBeUndefined();
  });
});
