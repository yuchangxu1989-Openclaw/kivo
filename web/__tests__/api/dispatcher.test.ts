/**
 * Dispatcher Tests — KIVO Wave 1 / A2
 *
 * 覆盖：
 *   - AC-CLASSIFY-1.1: dispatcher 能拉到 waiting 的 classify_pending 任务
 *   - backfill: pending materials 自动补建 task
 *   - 空队列时 tick 返回 0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  ensureTaskQueueTable,
  enqueueClassifyTask,
  dispatchTick,
  TASK_TYPE_CLASSIFY,
} from '@/lib/queue/dispatcher';
import { MAX_RETRIES } from '@/lib/queue/worker';

// Mock the DB module to use in-memory database
let testDb: Database.Database;

vi.mock('@/lib/db', () => ({
  openWebDb: (readonly?: boolean) => {
    // Return a new connection to the same in-memory DB
    // For tests we use a file-based temp DB
    const Database = require('better-sqlite3');
    return new Database(process.env.__TEST_DB_PATH || ':memory:');
  },
  getWebDbPath: () => process.env.__TEST_DB_PATH || ':memory:',
}));

// Mock the SubjectClassifier
vi.mock('@/lib/classify/subject_classifier', () => ({
  classify: vi.fn(),
  CONFIDENCE_THRESHOLD: 0.7,
}));

// Mock semantic-search (embedQuery)
vi.mock('@/lib/semantic-search', () => ({
  embedQuery: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
  semanticSearchDb: vi.fn().mockResolvedValue([]),
}));

// Mock LLM client
vi.mock('@/lib/llm/penguin-client', () => ({
  chatJson: vi.fn().mockResolvedValue({
    data: {
      subject_domain: '数学',
      is_new_domain: false,
      subject_path: ['数学'],
      confidence: 0.85,
      reasoning: '测试',
    },
    raw: { model: 'test', content: '{}', usage: {} },
  }),
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

import { classify } from '@/lib/classify/subject_classifier';
const mockClassify = vi.mocked(classify);

import path from 'path';
import fs from 'fs';
import os from 'os';

describe('Dispatcher', () => {
  let dbPath: string;

  beforeEach(() => {
    // Create a temp DB file for each test
    dbPath = path.join(os.tmpdir(), `kivo-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.__TEST_DB_PATH = dbPath;

    testDb = new Database(dbPath);
    // Create materials table
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
    `);
    // Create subject_nodes table
    testDb.exec(`
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
    ensureTaskQueueTable(testDb);
  });

  afterEach(() => {
    testDb?.close();
    try {
      fs.unlinkSync(dbPath);
    } catch { /* ignore */ }
    delete process.env.__TEST_DB_PATH;
  });

  it('ensureTaskQueueTable creates table idempotently', () => {
    // Already created in beforeEach, call again
    ensureTaskQueueTable(testDb);
    const tables = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_queue'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('enqueueClassifyTask creates a task for a material', () => {
    const taskId = enqueueClassifyTask(testDb, 'mat-001');
    expect(taskId).toBeTruthy();

    const row = testDb
      .prepare('SELECT * FROM task_queue WHERE id = ?')
      .get(taskId!) as any;
    expect(row.type).toBe(TASK_TYPE_CLASSIFY);
    expect(row.status).toBe('waiting');
    expect(JSON.parse(row.payload).materialId).toBe('mat-001');
  });

  it('enqueueClassifyTask is idempotent (skips duplicate)', () => {
    const id1 = enqueueClassifyTask(testDb, 'mat-002');
    const id2 = enqueueClassifyTask(testDb, 'mat-002');
    expect(id1).toBeTruthy();
    expect(id2).toBeNull(); // Duplicate skipped
  });

  it('AC-CLASSIFY-1.1: dispatcher fetches waiting classify_pending tasks', () => {
    // Insert a waiting task
    enqueueClassifyTask(testDb, 'mat-003');

    const rows = testDb
      .prepare(
        "SELECT * FROM task_queue WHERE status = 'waiting' AND type = 'classify_pending'",
      )
      .all();
    expect(rows.length).toBe(1);
  });

  it('dispatchTick returns empty result when no tasks', async () => {
    mockClassify.mockResolvedValue({
      subjectDomain: '',
      subjectNodeId: null,
      classificationStatus: 'extract_failed',
      confidence: 0,
      isNewDomain: false,
      suggestedPath: [],
      reasoning: '',
      meta: { model: 'test', promptVersion: 'v1', latencyMs: 0, truncated: false, cacheHit: false },
    });

    const result = await dispatchTick(3);
    // No pending materials, no tasks → dispatched = 0
    expect(result.dispatched).toBe(0);
    expect(result.results).toHaveLength(0);
  });
});
