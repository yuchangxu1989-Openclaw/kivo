/**
 * Worker Tests — KIVO Wave 1 / A2
 *
 * 覆盖三条核心路径：
 *   - confidence 高 → classified (AC-CLASSIFY-2.1)
 *   - confidence 低 → pending (AC-CLASSIFY-2.2)
 *   - 失败重试 → retry_count++ → 达 3 次 failed (AC-CLASSIFY-4.1)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Mock DB
vi.mock('@/lib/db', () => ({
  openWebDb: (readonly?: boolean) => {
    const Database = require('better-sqlite3');
    return new Database(process.env.__TEST_DB_PATH || ':memory:');
  },
  getWebDbPath: () => process.env.__TEST_DB_PATH || ':memory:',
}));

// Mock SubjectClassifier
vi.mock('@/lib/classify/subject_classifier', () => ({
  classify: vi.fn(),
  CONFIDENCE_THRESHOLD: 0.7,
}));

// Mock semantic-search
vi.mock('@/lib/semantic-search', () => ({
  embedQuery: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
  semanticSearchDb: vi.fn().mockResolvedValue([]),
}));

// Mock LLM
vi.mock('@/lib/llm/penguin-client', () => ({
  chatJson: vi.fn(),
  chatComplete: vi.fn(),
  extractJsonObject: vi.fn(),
  LlmClientError: class extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  },
}));

// Mock subjects repository
vi.mock('@/lib/subjects/repository', () => ({
  getSubjectRepository: vi.fn().mockReturnValue({
    listTree: vi.fn().mockReturnValue([]),
  }),
  SubjectRepository: vi.fn(),
  SubjectRepoError: class extends Error {},
}));

// Mock wiki-materials-store
vi.mock('@/lib/wiki-materials-store', () => ({
  ensureMaterialsTable: vi.fn(),
}));

import { classify } from '@/lib/classify/subject_classifier';
import { executeTask, MAX_RETRIES, type TaskRow } from '@/lib/queue/worker';
import type { ClassificationResult } from '@/lib/classify/subject_classifier';

const mockClassify = vi.mocked(classify);

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-001',
    type: 'classify_pending',
    payload: JSON.stringify({ materialId: 'mat-001', content: '' }),
    status: 'waiting',
    retry_count: 0,
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeClassifyResult(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    subjectDomain: '数学',
    subjectNodeId: 'subj-001',
    classificationStatus: 'auto_assigned',
    confidence: 0.92,
    isNewDomain: false,
    suggestedPath: ['数学', '高等数学'],
    reasoning: '内容明显属于高等数学',
    meta: {
      model: 'test-model',
      promptVersion: 'subject-classifier-v1',
      latencyMs: 100,
      truncated: false,
      cacheHit: false,
    },
    ...overrides,
  };
}

describe('Worker', () => {
  let testDb: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `kivo-worker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.__TEST_DB_PATH = dbPath;

    testDb = new Database(dbPath);
    // Create tables
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS materials (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        file_size INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'processing',
        space_id TEXT NOT NULL DEFAULT 'default',
        wiki_page_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        storage_path TEXT NOT NULL DEFAULT '',
        wiki_page_ids_json TEXT NOT NULL DEFAULT '[]',
        error_message TEXT,
        subject_node_id TEXT,
        classification_status TEXT DEFAULT 'pending',
        classification_confidence REAL,
        suggested_subject_name TEXT,
        pipeline_status TEXT,
        asset_kind TEXT,
        source_channel TEXT,
        source_ref TEXT,
        classification_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS task_queue (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'waiting',
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS subject_nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        name TEXT NOT NULL,
        tree_kind TEXT NOT NULL DEFAULT 'subject',
        origin TEXT NOT NULL DEFAULT 'auto',
        created_by_material_id TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        confidence REAL,
        aliases TEXT,
        merged_into TEXT,
        level INTEGER DEFAULT 0
      );
    `);

    // Insert test material
    testDb.prepare(`
      INSERT INTO materials (id, file_name, classification_status, asset_kind, source_channel, source_ref)
      VALUES ('mat-001', '概率论讲义.pdf', 'pending', 'pdf', 'web_upload', 'upload://material/mat-001')
    `).run();

    // Insert test task
    testDb.prepare(`
      INSERT INTO task_queue (id, type, payload, status, retry_count)
      VALUES ('task-001', 'classify_pending', '{"materialId":"mat-001","content":""}', 'waiting', 0)
    `).run();

    // Insert a subject node for matching
    testDb.prepare(`
      INSERT INTO subject_nodes (id, name, level, created_at)
      VALUES ('subj-001', '数学', 0, 1716537600)
    `).run();
  });

  afterEach(() => {
    testDb?.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    delete process.env.__TEST_DB_PATH;
  });

  it('AC-CLASSIFY-2.1: high confidence → classified + subject_node_id', async () => {
    mockClassify.mockResolvedValue(makeClassifyResult({
      classificationStatus: 'auto_assigned',
      subjectNodeId: 'subj-001',
      confidence: 0.92,
    }));

    const result = await executeTask(makeTask());

    expect(result.success).toBe(true);
    expect(result.classificationStatus).toBe('classified');
    expect(result.subjectNodeId).toBe('subj-001');
    expect(result.confidence).toBe(0.92);

    // Verify DB state
    const mat = testDb
      .prepare('SELECT classification_status, subject_node_id, classification_confidence FROM materials WHERE id = ?')
      .get('mat-001') as any;
    expect(mat.classification_status).toBe('classified');
    expect(mat.subject_node_id).toBe('subj-001');
    expect(mat.classification_confidence).toBe(0.92);

    // Verify task marked done
    const task = testDb
      .prepare('SELECT status FROM task_queue WHERE id = ?')
      .get('task-001') as any;
    expect(task.status).toBe('done');
  });

  it('AC-CLASSIFY-2.2: low confidence → pending (needs_review)', async () => {
    mockClassify.mockResolvedValue(makeClassifyResult({
      classificationStatus: 'pending',
      subjectNodeId: null,
      confidence: 0.55,
      subjectDomain: '可能是数学',
      reasoning: '置信度不足，需人工确认',
    }));

    const result = await executeTask(makeTask());

    expect(result.success).toBe(true);
    expect(result.classificationStatus).toBe('needs_review');
    expect(result.subjectNodeId).toBeNull();
    expect(result.confidence).toBe(0.55);

    // Verify DB state
    const mat = testDb
      .prepare('SELECT classification_status, subject_node_id, classification_confidence, suggested_subject_name FROM materials WHERE id = ?')
      .get('mat-001') as any;
    expect(mat.classification_status).toBe('needs_review');
    expect(mat.subject_node_id).toBeNull();
    expect(mat.classification_confidence).toBe(0.55);
    expect(mat.suggested_subject_name).toBe('可能是数学');

    // Task done (low confidence is still a successful classification)
    const task = testDb
      .prepare('SELECT status FROM task_queue WHERE id = ?')
      .get('task-001') as any;
    expect(task.status).toBe('done');
  });

  it('AC-CLASSIFY-4.1: failure increments retry_count, 3rd failure → status=failed', async () => {
    // First failure (retry_count goes 0 → 1)
    mockClassify.mockResolvedValue(makeClassifyResult({
      classificationStatus: 'extract_failed',
      confidence: 0,
      meta: {
        model: 'test',
        promptVersion: 'v1',
        latencyMs: 0,
        truncated: false,
        cacheHit: false,
        error: 'LLM timeout',
      },
    }));

    const result1 = await executeTask(makeTask({ retry_count: 0 }));
    expect(result1.success).toBe(false);

    // Check retry_count incremented
    let task = testDb
      .prepare('SELECT status, retry_count FROM task_queue WHERE id = ?')
      .get('task-001') as any;
    expect(task.retry_count).toBe(1);
    expect(task.status).toBe('waiting'); // Still waiting for retry

    // Material should be back to pending (not failed yet)
    let mat = testDb
      .prepare('SELECT classification_status FROM materials WHERE id = ?')
      .get('mat-001') as any;
    expect(mat.classification_status).toBe('pending');

    // Second failure (retry_count 1 → 2)
    const result2 = await executeTask(makeTask({ retry_count: 1 }));
    expect(result2.success).toBe(false);
    task = testDb
      .prepare('SELECT status, retry_count FROM task_queue WHERE id = ?')
      .get('task-001') as any;
    expect(task.retry_count).toBe(2);
    expect(task.status).toBe('waiting');

    // Third failure (retry_count 2 → 3 = MAX_RETRIES) → final failure
    const result3 = await executeTask(makeTask({ retry_count: 2 }));
    expect(result3.success).toBe(false);
    expect(result3.classificationStatus).toBe('failed');

    task = testDb
      .prepare('SELECT status, retry_count FROM task_queue WHERE id = ?')
      .get('task-001') as any;
    expect(task.retry_count).toBe(3);
    expect(task.status).toBe('failed');

    // Material should now be failed
    mat = testDb
      .prepare('SELECT classification_status FROM materials WHERE id = ?')
      .get('mat-001') as any;
    expect(mat.classification_status).toBe('failed');
  });

  it('FR-B03 AC2: new domain with high confidence → creates root node + classified', async () => {
    mockClassify.mockResolvedValue(makeClassifyResult({
      classificationStatus: 'pending',
      subjectNodeId: null,
      subjectDomain: '健康管理',
      isNewDomain: true,
      confidence: 0.88,
      suggestedPath: ['健康管理'],
      reasoning: '内容明显属于健康管理领域，建议新建根节点',
    }));

    const result = await executeTask(makeTask());

    expect(result.success).toBe(true);
    expect(result.classificationStatus).toBe('classified');
    expect(result.subjectNodeId).toBeTruthy();
    expect(result.confidence).toBe(0.88);

    // Verify a new root node was created
    const node = testDb
      .prepare('SELECT id, name, parent_id, level, origin, created_by_material_id, confidence FROM subject_nodes WHERE name = ?')
      .get('健康管理') as any;
    expect(node).toBeTruthy();
    expect(node.parent_id).toBeNull();
    expect(node.level).toBe(0);
    expect(node.origin).toBe('auto');
    expect(node.created_by_material_id).toBe('mat-001');
    expect(node.confidence).toBe(0.88);

    // Verify material classified with the new node
    const mat = testDb
      .prepare('SELECT classification_status, subject_node_id, classification_confidence FROM materials WHERE id = ?')
      .get('mat-001') as any;
    expect(mat.classification_status).toBe('classified');
    expect(mat.subject_node_id).toBe(node.id);

    // Verify task done
    const task = testDb
      .prepare('SELECT status FROM task_queue WHERE id = ?')
      .get('task-001') as any;
    expect(task.status).toBe('done');
  });

  it('FR-B03 AC2: new domain with existing root → reuses root (idempotent)', async () => {
    // Pre-create the root node that would be found
    const existingId = 'existing-root-001';
    testDb.prepare(`
      INSERT INTO subject_nodes (id, name, parent_id, level, created_at, origin)
      VALUES (?, '健康管理', NULL, 0, 1716537600, 'auto')
    `).run(existingId);

    mockClassify.mockResolvedValue(makeClassifyResult({
      classificationStatus: 'pending',
      subjectNodeId: null,
      subjectDomain: '健康管理',
      isNewDomain: true,
      confidence: 0.88,
      suggestedPath: ['健康管理'],
      reasoning: '内容明显属于健康管理领域',
    }));

    const result = await executeTask(makeTask());

    expect(result.success).toBe(true);
    expect(result.classificationStatus).toBe('classified');
    expect(result.subjectNodeId).toBe(existingId);

    // Verify no duplicate root was created (only 1 node named '健康管理')
    const nodes = testDb
      .prepare("SELECT COUNT(*) AS c FROM subject_nodes WHERE name = '健康管理'")
      .get() as any;
    expect(nodes.c).toBe(1);

    // Verify material assigned to existing node
    const mat = testDb
      .prepare('SELECT subject_node_id FROM materials WHERE id = ?')
      .get('mat-001') as any;
    expect(mat.subject_node_id).toBe(existingId);
  });

  it('handles invalid payload gracefully', async () => {
    const badTask = makeTask({ payload: 'not-json{{{' });
    const result = await executeTask(badTask);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid task payload');
  });

  it('handles missing material gracefully', async () => {
    const task = makeTask({
      payload: JSON.stringify({ materialId: 'nonexistent-id' }),
    });
    const result = await executeTask(task);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});
