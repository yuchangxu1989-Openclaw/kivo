import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const chatJsonMock = vi.fn();

vi.mock('@/lib/llm/penguin-client', () => ({
  chatJson: (...args: unknown[]) => chatJsonMock(...args),
}));

vi.mock('@/lib/kivo-engine', () => ({
  persistEntry: async (entry: { id: string; title?: string }) => {
    const db = new Database(process.env.KIVO_DB_PATH!);
    try {
      db.prepare('INSERT OR IGNORE INTO entries (id, title) VALUES (?, ?)').run(entry.id, entry.title ?? '');
    } finally {
      db.close();
    }
    return true;
  },
}));

let tmpRoot = '';
let dbPath = '';
let originalPath = process.env.PATH;

function openDb() {
  return new Database(dbPath);
}

function createMinimalEntriesTable() {
  const db = openDb();
  try {
    db.exec('CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, title TEXT)');
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kivo-research-registry-'));
  dbPath = join(tmpRoot, 'kivo.db');
  process.env.KIVO_DB_PATH = dbPath;
  process.env.KIVO_WORKSPACE_ROOT = tmpRoot;
  originalPath = process.env.PATH;
  chatJsonMock.mockReset();
  vi.unstubAllGlobals();
  createMinimalEntriesTable();
});

afterEach(() => {
  delete process.env.KIVO_DB_PATH;
  delete process.env.KIVO_WORKSPACE_ROOT;
  delete process.env.KIVO_ENABLE_REAL_MODELS_IN_TEST;
  delete process.env.LARK_ACCESS_TOKEN;
  delete process.env.FEISHU_ACCESS_TOKEN;
  process.env.PATH = originalPath;
  vi.unstubAllGlobals();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('research registry backend', () => {
  it('normalizes topics, registers multiple tasks, and preserves multiple reports', async () => {
    const dbMod = await import('../../lib/research-db');

    const first = await dbMod.registerResearchTask({
      topicName: 'KIVO   调研登记簿',
      taskTitle: '第一轮调研',
      actorId: 'agent-a',
      executorId: 'codex-1',
    });
    const second = await dbMod.registerResearchTask({
      topicName: 'kivo 调研登记簿',
      taskTitle: '第二轮调研',
      actorId: 'agent-b',
      executorId: 'codex-2',
    });

    expect(second.topic.id).toBe(first.topic.id);

    const reportDir = join(tmpRoot, 'reports');
    mkdirSync(reportDir, { recursive: true });
    const reportOne = join(reportDir, 'one.md');
    const reportTwo = join(reportDir, 'two.md');
    writeFileSync(reportOne, '# 第一份报告\n\n结论 A', 'utf8');
    writeFileSync(reportTwo, '# 第二份报告\n\n结论 B', 'utf8');

    dbMod.updateRegisteredResearchTaskStatus({
      taskId: first.task.id,
      status: 'completed',
      reportUri: 'reports/one.md',
      reportTitle: '第一份报告',
    });
    dbMod.registerResearchReport({
      taskId: first.task.id,
      title: '第二份报告',
      reportUri: 'reports/two.md',
      externalContentHash: 'agent-wrong-hash',
    });

    const db = openDb();
    try {
      const topic = db.prepare('SELECT task_count, report_count FROM research_topics WHERE id = ?').get(first.topic.id) as { task_count: number; report_count: number };
      expect(topic.task_count).toBe(2);
      expect(topic.report_count).toBe(2);
      expect((db.prepare('SELECT COUNT(*) AS c FROM research_reports').get() as { c: number }).c).toBe(2);
      const task = db.prepare('SELECT status, report_path, executor_id FROM research_tasks WHERE id = ?').get(first.task.id) as { status: string; report_path: string; executor_id: string };
      expect(task.status).toBe('completed');
      expect(task.report_path).toBe('reports/one.md');
      expect(task.executor_id).toBe('codex-1');
    } finally {
      db.close();
    }
  });

  it('confirms a local report from full text, computes KIVO hash, extracts entries, and deduplicates repeats', async () => {
    const dbMod = await import('../../lib/research-db');
    chatJsonMock.mockResolvedValue({
      data: {
        entries: [
          {
            type: 'fact',
            title: '调研登记簿需要报告级确认',
            summary: '用户确认整篇报告后才入库。',
            content: '确认粒度是整篇报告，KIVO 在确认流程读取全文并提取 Wiki 条目。',
            confidence: 0.91,
            tags: ['registry'],
            domain: 'KIVO',
          },
        ],
      },
      raw: { model: 'test-model', content: '{}' },
    });

    const task = await dbMod.registerResearchTask({ topicName: '报告确认', taskTitle: '确认调研' });
    mkdirSync(join(tmpRoot, 'reports'), { recursive: true });
    const reportContent = '# 报告确认\n\nKIVO 必须读取全文，而不是信任摘要或外部 hash。\n';
    writeFileSync(join(tmpRoot, 'reports', 'confirm.md'), reportContent, 'utf8');
    const report = dbMod.registerResearchReport({
      taskId: task.task.id,
      title: '确认报告',
      reportUri: 'reports/confirm.md',
      externalContentHash: 'wrong-agent-hash',
    });

    const result = await dbMod.confirmResearchReportReference({ reportId: report.id, confirmedBy: 'unit-user' });
    const expectedHash = createHash('sha256').update(reportContent.trim(), 'utf8').digest('hex');
    expect(result?.status).toBe('completed');
    expect(result?.contentHash).toBe(expectedHash);
    expect(result?.insertedCount).toBe(1);

    const duplicate = await dbMod.confirmResearchReportReference({ reportId: report.id, confirmedBy: 'unit-user' });
    expect(duplicate?.status).toBe('duplicate');

    const db = openDb();
    try {
      const stored = db.prepare('SELECT content_hash, external_content_hash, is_reference, reference_marked_by FROM research_reports WHERE id = ?').get(report.id) as {
        content_hash: string;
        external_content_hash: string;
        is_reference: number;
        reference_marked_by: string;
      };
      expect(stored.content_hash).toBe(expectedHash);
      expect(stored.external_content_hash).toBe('wrong-agent-hash');
      expect(stored.is_reference).toBe(1);
      expect(stored.reference_marked_by).toBe('unit-user');
      expect((db.prepare("SELECT COUNT(*) AS c FROM research_reference_batches WHERE status = 'completed'").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM research_reference_batches WHERE status = 'duplicate'").get() as { c: number }).c).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS c FROM research_report_entries').get() as { c: number }).c).toBe(1);
    } finally {
      db.close();
    }
  });

  it('records failure when a local report escapes the workspace', async () => {
    const dbMod = await import('../../lib/research-db');
    const task = await dbMod.registerResearchTask({ topicName: '失败处理', taskTitle: '越界报告' });
    const report = dbMod.registerResearchReport({
      taskId: task.task.id,
      title: '越界报告',
      reportUri: '/tmp/outside-kivo-report.md',
    });

    const result = await dbMod.confirmResearchReportReference({ reportId: report.id, confirmedBy: 'unit-user' });
    expect(result?.status).toBe('failed');
    expect(result?.failureReason).toContain('escapes workspace');

    const db = openDb();
    try {
      const row = db.prepare('SELECT failure_reason FROM research_reports WHERE id = ?').get(report.id) as { failure_reason: string };
      expect(row.failure_reason).toContain('escapes workspace');
      const batch = db.prepare('SELECT status, error_message FROM research_reference_batches WHERE report_id = ?').get(report.id) as { status: string; error_message: string };
      expect(batch.status).toBe('failed');
      expect(batch.error_message).toContain('escapes workspace');
    } finally {
      db.close();
    }
  });

  it('returns the full topic task report batch wiki registry projection', async () => {
    const dbMod = await import('../../lib/research-db');
    chatJsonMock.mockResolvedValue({
      data: {
        entries: [{
          type: 'fact',
          title: '登记簿 API 暴露追溯字段',
          content: '外部 API 必须能从主题追溯到任务、报告、确认批次和 Wiki 条目。',
          confidence: 0.9,
        }],
      },
      raw: { model: 'test-model', content: '{}' },
    });

    const task = await dbMod.registerResearchTask({ topicName: 'API 登记簿', taskTitle: 'API 验收' });
    mkdirSync(join(tmpRoot, 'reports'), { recursive: true });
    const reportContent = '# API 登记簿\n\n完整结构必须可读。\n';
    writeFileSync(join(tmpRoot, 'reports', 'api.md'), reportContent, 'utf8');
    const report = dbMod.registerResearchReport({ taskId: task.task.id, title: 'API 报告', reportUri: 'reports/api.md' });
    const confirmation = await dbMod.confirmResearchReportReference({ reportId: report.id, confirmedBy: 'unit-user' });

    const dashboard = dbMod.getResearchDashboardData();
    expect(dashboard.topics).toHaveLength(1);
    const topic = dashboard.topics[0];
    expect(topic.taskCount).toBe(1);
    expect(topic.reportCount).toBe(1);
    expect(topic.referenceReportCount).toBe(1);
    expect(topic.wikiEntryCount).toBe(1);
    expect(topic.tasks[0].reports[0]).toMatchObject({
      id: report.id,
      reportUri: 'reports/api.md',
      isReference: true,
      sourceType: 'local',
      contentHash: confirmation?.contentHash,
      batchStatus: 'completed',
      insertedCount: 1,
      wikiEntryCount: 1,
    });
    expect(topic.tasks[0].reports[0].referenceBatches[0]).toMatchObject({
      status: 'completed',
      sourceType: 'local',
      contentHash: confirmation?.contentHash,
      insertedCount: 1,
    });
    expect(topic.tasks[0].reports[0].wikiEntries?.[0]?.title).toBe('登记簿 API 暴露追溯字段');
  });

  it('reuses semantically equivalent topic names by embedding and keeps unrelated topics separate', async () => {
    process.env.KIVO_ENABLE_REAL_MODELS_IN_TEST = '1';
    const vectors = new Map<string, number[]>([
      ['AI 安全研究', [1, 0]],
      ['人工智能安全调研', [0.99, 0.01]],
      ['海洋生态调查', [0, 1]],
    ]);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string };
      return new Response(JSON.stringify({ data: [{ embedding: vectors.get(body.input ?? '') ?? [0, 1] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const dbMod = await import('../../lib/research-db');
    const first = await dbMod.registerResearchTask({ topicName: 'AI 安全研究', taskTitle: '第一轮' });
    const synonym = await dbMod.registerResearchTask({ topicName: '人工智能安全调研', taskTitle: '第二轮' });
    const unrelated = await dbMod.registerResearchTask({ topicName: '海洋生态调查', taskTitle: '第三轮' });

    expect(synonym.topic.id).toBe(first.topic.id);
    expect(unrelated.topic.id).not.toBe(first.topic.id);
    const db = openDb();
    try {
      expect((db.prepare('SELECT COUNT(*) AS c FROM research_topics').get() as { c: number }).c).toBe(2);
    } finally {
      db.close();
    }
  });

  it('reads Lark reports through lark-cli without raw token environment variables', async () => {
    delete process.env.LARK_ACCESS_TOKEN;
    delete process.env.FEISHU_ACCESS_TOKEN;
    const binDir = join(tmpRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const cli = join(binDir, 'lark-cli');
    writeFileSync(cli, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({data:{markdown:"# 飞书报告\\n\\n通过本机 bot 授权读取全文。"}}));\n', 'utf8');
    chmodSync(cli, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    chatJsonMock.mockResolvedValue({
      data: { entries: [{ type: 'fact', title: '飞书全文读取', content: 'KIVO 使用 lark-cli 读取飞书报告全文。' }] },
      raw: { model: 'test-model', content: '{}' },
    });

    const dbMod = await import('../../lib/research-db');
    const task = await dbMod.registerResearchTask({ topicName: '飞书报告', taskTitle: '飞书成功' });
    const report = dbMod.registerResearchReport({ taskId: task.task.id, title: '飞书报告', reportUri: 'lark:doc-success' });
    const result = await dbMod.confirmResearchReportReference({ reportId: report.id, confirmedBy: 'unit-user' });

    expect(result?.status).toBe('completed');
    expect(result?.sourceType).toBe('lark');
    expect(result?.insertedCount).toBe(1);
  });

  it('records no-permission and empty-body Lark fetch failures from lark-cli', async () => {
    const binDir = join(tmpRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const cli = join(binDir, 'lark-cli');
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;

    const dbMod = await import('../../lib/research-db');
    const task = await dbMod.registerResearchTask({ topicName: '飞书失败', taskTitle: '飞书失败' });
    const denied = dbMod.registerResearchReport({ taskId: task.task.id, title: '无权限报告', reportUri: 'lark:doc-denied' });
    writeFileSync(cli, '#!/usr/bin/env node\nprocess.stderr.write("Forbidden"); process.exit(1);\n', 'utf8');
    chmodSync(cli, 0o755);
    const deniedResult = await dbMod.confirmResearchReportReference({ reportId: denied.id, confirmedBy: 'unit-user' });
    expect(deniedResult?.status).toBe('failed');
    expect(deniedResult?.failureReason).toContain('lark-cli');

    const empty = dbMod.registerResearchReport({ taskId: task.task.id, title: '空正文报告', reportUri: 'lark:doc-empty' });
    writeFileSync(cli, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({data:{markdown:""}}));\n', 'utf8');
    chmodSync(cli, 0o755);
    const emptyResult = await dbMod.confirmResearchReportReference({ reportId: empty.id, confirmedBy: 'unit-user' });
    expect(emptyResult?.status).toBe('failed');
    expect(emptyResult?.failureReason).toContain('empty content');
  });
});