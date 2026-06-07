import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

const BASE = 'http://localhost:3000';
let tmpRoot = '';
let dbPath = '';

function makeRequest(path: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(new URL(path, BASE), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function countRows(table: string): number {
  const db = new Database(dbPath);
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kivo-research-loop-'));
  dbPath = join(tmpRoot, 'kivo.db');
  process.env.KIVO_DB_PATH = dbPath;
});

afterEach(() => {
  delete process.env.KIVO_DB_PATH;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('FR-D01 research API and lifecycle', () => {
  it('POST /api/v1/research creates a visible task from a query', async () => {
    const route = await import('../../app/api/v1/research/route');
    const res = await route.POST(makeRequest('/api/v1/research', 'POST', {
      query: '帮我调研 KIVO 调研队列闭环',
      requestedBy: 'unit-test',
    }));

    expect(res.status).toBe(201);
    const body = await json<{ data: { tasks: Array<{ id: string; topic: string; status: string }> } }>(res);
    expect(body.data.tasks.length).toBe(1);
    expect(body.data.tasks[0].topic).toContain('KIVO 调研队列闭环');
    expect(['queued', 'running', 'completed']).toContain(body.data.tasks[0].status);

    const db = new Database(dbPath);
    try {
      const row = db.prepare('SELECT query, requested_by, status FROM research_tasks LIMIT 1').get() as { query: string; requested_by: string; status: string };
      expect(row.query).toContain('KIVO 调研队列闭环');
      expect(row.requested_by).toBe('unit-test');
      expect(['pending', 'executing', 'completed']).toContain(row.status);
    } finally {
      db.close();
    }
  });

  it('state machine can move pending to executing to completed with a report path', async () => {
    const dbMod = await import('../../lib/research-db');
    const dashboard = await dbMod.createResearchTask({
      query: '状态机测试',
      topic: '状态机测试',
      scope: 'unit',
      priority: 'medium',
      requestedBy: 'unit-test',
      budgetCredits: 20,
      expectedTypes: ['fact'],
      autoExecute: false,
    });
    const id = dashboard.tasks[0].id;

    dbMod.updateResearchTaskStatusForTest(id, 'executing');
    let detail = dbMod.getResearchTaskDetail(id);
    expect(detail?.status).toBe('running');

    const reportDir = join(tmpRoot, 'reports');
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, 'research-state.md');
    writeFileSync(reportPath, '# 状态机测试\n\n这是一份调研报告。', 'utf8');
    dbMod.updateResearchTaskStatusForTest(id, 'completed', reportPath);
    detail = dbMod.getResearchTaskDetail(id);
    expect(detail?.status).toBe('completed');
    expect(detail?.reportContent).toContain('调研报告');
  });
});

describe('FR-D02 research queue adoption flow', () => {
  it('GET detail exposes report content and adopt writes entries plus operation log', async () => {
    const dbMod = await import('../../lib/research-db');
    const dashboard = await dbMod.createResearchTask({
      query: '采纳流程测试',
      topic: '采纳流程测试',
      scope: 'unit',
      priority: 'high',
      requestedBy: 'unit-test',
      budgetCredits: 36,
      expectedTypes: ['fact', 'methodology'],
      autoExecute: false,
    });
    const id = dashboard.tasks[0].id;
    const reportDir = join(tmpRoot, 'reports');
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, 'research-adopt.md');
    writeFileSync(reportPath, '# 采纳流程测试\n\n## 结论\n这份调研报告具有跨场景复用价值。', 'utf8');
    dbMod.updateResearchTaskStatusForTest(id, 'completed', reportPath);

    const detailRoute = await import('../../app/api/v1/research/[id]/route');
    const detailRes = await detailRoute.GET(makeRequest(`/api/v1/research/${id}`), { params: Promise.resolve({ id }) });
    expect(detailRes.status).toBe(200);
    const detailBody = await json<{ data: { reportContent: string } }>(detailRes);
    expect(detailBody.data.reportContent).toContain('跨场景复用价值');

    const adoptRoute = await import('../../app/api/v1/research/[id]/adopt/route');
    const adoptRes = await adoptRoute.POST(makeRequest(`/api/v1/research/${id}/adopt`, 'POST'), { params: Promise.resolve({ id }) });
    if (adoptRes.status !== 200) {
      const err = await json<unknown>(adoptRes);
      throw new Error(`adopt failed: ${JSON.stringify(err)}`);
    }
    expect(adoptRes.status).toBe(200);
    expect(countRows('entries')).toBeGreaterThanOrEqual(2);
    expect(countRows('operation_logs')).toBeGreaterThanOrEqual(1);

    const adopted = dbMod.getResearchTaskDetail(id);
    expect(adopted?.adopted).toBe(true);
    expect(adopted?.resultEntryIds?.length).toBeGreaterThanOrEqual(2);
  });
});
