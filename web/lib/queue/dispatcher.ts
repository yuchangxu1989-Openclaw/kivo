/**
 * Queue Dispatcher — KIVO Wave 1 / A2
 *
 * 拉取 task_queue（status='waiting' 且 type='classify_pending'），
 * 并发度 = 3，调 worker 执行分类任务。
 *
 * AC 覆盖：
 *   AC-CLASSIFY-1.1: dispatcher 能拉到 waiting 的 classify_pending 任务
 *   AC-CLASSIFY-4.1: 失败 retry_count++，达 3 次后 status='failed'
 *   AC-CLASSIFY-4.2: cron 端点鉴权（由 route.ts 实现）
 *
 * 设计：
 *   - 每次 tick 拉最多 concurrency * 2 条 waiting 任务
 *   - 并发执行（Promise.allSettled），并发度默认 3
 *   - 失败任务由 worker 内部处理 retry_count
 *   - 新 material 入库时由 A1 ingest 写入 task_queue 一行
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openWebDb } from '@/lib/db';
import {
  ensureSubjectClassificationSchema,
  executeTask,
  type TaskRow,
  type WorkerResult,
} from '@/lib/queue/worker';
import { ensureMaterialsTable } from '@/lib/wiki-materials-store';
import {
  executePipelineTask,
  executeExtractBatchTask,
  backfillPipelineForClassified,
  TASK_TYPE_PIPELINE,
  TASK_TYPE_EXTRACT_BATCH,
  type PipelineResult,
} from '@/lib/queue/pipeline-worker';

// ─── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_CONCURRENCY = 3;
export const TASK_TYPE_CLASSIFY = 'classify_pending';
export { TASK_TYPE_PIPELINE, TASK_TYPE_EXTRACT_BATCH };
export const MAX_BATCH_SIZE = 10;
const DISPATCH_TASK_TYPES = [TASK_TYPE_CLASSIFY, TASK_TYPE_PIPELINE, TASK_TYPE_EXTRACT_BATCH] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DispatchResult {
  tickId: string;
  dispatched: number;
  succeeded: number;
  failed: number;
  results: WorkerResult[];
  durationMs: number;
}

// ─── Schema bootstrap ────────────────────────────────────────────────────────

/**
 * 确保 task_queue 表存在。幂等，每次 tick 开头调用。
 */
export function ensureTaskQueueTable(db: Database.Database): void {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_task_queue_status_type
      ON task_queue(status, type);
    CREATE INDEX IF NOT EXISTS idx_task_queue_created
      ON task_queue(created_at);
  `);
}

// ─── Enqueue helper (called by A1 ingest or migration) ───────────────────────

/**
 * 为一个 material 创建 classify_pending 任务。幂等：如果已有同 materialId
 * 的 waiting/running 任务则跳过。
 */
export function enqueueClassifyTask(
  db: Database.Database,
  materialId: string,
  content?: string,
): string | null {
  ensureTaskQueueTable(db);

  // Check for existing non-terminal task
  const existing = db
    .prepare(
      `SELECT id FROM task_queue
        WHERE type = 'classify_pending'
          AND json_extract(payload, '$.materialId') = ?
          AND status IN ('waiting', 'running')
        LIMIT 1`,
    )
    .get(materialId) as { id: string } | undefined;

  if (existing) return null; // Already queued

  const taskId = randomUUID();
  const payload = JSON.stringify({ materialId, content: content || '' });

  db.prepare(
    `INSERT INTO task_queue (id, type, payload, status, retry_count, created_at, updated_at)
     VALUES (@id, @type, @payload, 'waiting', 0, datetime('now'), datetime('now'))`,
  ).run({
    id: taskId,
    type: TASK_TYPE_CLASSIFY,
    payload,
  });

  return taskId;
}

/**
 * Mark materials stuck in 'processing' status for >10 minutes as failed.
 * This prevents the UI from showing a perpetual "processing" spinner.
 */
function failStuckProcessingMaterials(db: Database.Database): number {
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '');
  const stuck = db
    .prepare(
      `SELECT id FROM materials
        WHERE status = 'processing'
          AND (pipeline_status IS NULL OR pipeline_status NOT IN ('done', 'failed'))
          AND updated_at < ?
        LIMIT 50`,
    )
    .all(tenMinAgo) as Array<{ id: string }>;
  if (stuck.length === 0) return 0;
  const update = db.prepare(
    `UPDATE materials
        SET status = 'failed',
            pipeline_status = 'failed',
            error_message = '处理超时（超过 10 分钟未完成），可点击重新处理',
            updated_at = datetime('now')
      WHERE id = ?`,
  );
  for (const row of stuck) {
    update.run(row.id);
  }
  return stuck.length;
}

// ─── Fetch waiting tasks ─────────────────────────────────────────────────────

function fetchWaitingTasks(
  db: Database.Database,
  limit: number,
): TaskRow[] {
  const placeholders = DISPATCH_TASK_TYPES.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT id, type, payload, status, retry_count, last_error, created_at, updated_at
         FROM task_queue
        WHERE status = 'waiting' AND type IN (${placeholders})
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(...DISPATCH_TASK_TYPES, limit) as TaskRow[];
}

// ─── Dispatcher tick ─────────────────────────────────────────────────────────

/**
 * 单次 tick：拉取 waiting 任务，并发执行，返回结果汇总。
 *
 * 由 cron 端点 POST /api/internal/dispatcher/tick 触发。
 */
export async function dispatchTick(
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<DispatchResult> {
  const tickId = randomUUID();
  const startMs = Date.now();

  const db = openWebDb(false);
  ensureMaterialsTable(db);
  ensureTaskQueueTable(db);
  ensureSubjectClassificationSchema(db);

  // Also ensure any pending materials without tasks get enqueued
  backfillPendingMaterials(db);
  // FR-A02: classified-but-not-yet-pipelined materials → process_pipeline 任务
  backfillPipelineForClassified(db);
  // Mark materials stuck in 'processing' for >10 min as failed
  const stuckCount = failStuckProcessingMaterials(db);
  if (stuckCount > 0) {
    console.log(`[dispatcher] marked ${stuckCount} stuck processing materials as failed`);
  }

  const tasks = fetchWaitingTasks(db, Math.min(concurrency * 2, MAX_BATCH_SIZE));
  db.close();

  if (tasks.length === 0) {
    return {
      tickId,
      dispatched: 0,
      succeeded: 0,
      failed: 0,
      results: [],
      durationMs: Date.now() - startMs,
    };
  }

  // Execute with concurrency limit
  const results: WorkerResult[] = [];
  const batches = chunkArray(tasks, concurrency);

  for (const batch of batches) {
    const batchResults = await Promise.allSettled(
      batch.map((task) => runTask(task)),
    );

    for (const settled of batchResults) {
      if (settled.status === 'fulfilled') {
        results.push(settled.value);
      } else {
        // Should not happen since executeTask catches internally
        results.push({
          taskId: 'unknown',
          materialId: '',
          success: false,
          classificationStatus: null,
          subjectNodeId: null,
          confidence: null,
          error: settled.reason?.message || 'Unknown dispatch error',
        });
      }
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    tickId,
    dispatched: results.length,
    succeeded,
    failed,
    results,
    durationMs: Date.now() - startMs,
  };
}

// ─── Backfill: ensure all pending materials have a task ──────────────────────

/**
 * 扫描 materials 表中 classification_status='pending' 但没有对应
 * task_queue 行的记录，补建任务。这保证即使 A1 没有写 task_queue
 * （向后兼容），dispatcher 也能消费。
 */
function backfillPendingMaterials(db: Database.Database): void {
  const pendingMaterials = db
    .prepare(
      `SELECT m.id, m.file_name
         FROM materials m
        WHERE m.classification_status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM task_queue t
             WHERE t.type = 'classify_pending'
               AND json_extract(t.payload, '$.materialId') = m.id
               AND t.status IN ('waiting', 'running')
          )
        ORDER BY m.created_at ASC
        LIMIT 20`,
    )
    .all() as Array<{ id: string; file_name: string }>;

  for (const mat of pendingMaterials) {
    enqueueClassifyTask(db, mat.id);
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function pipelineResultToWorkerResult(r: PipelineResult): WorkerResult {
  const errorParts: string[] = [];
  if (r.error) errorParts.push(r.error);
  if (r.skipped && r.reason) errorParts.push(`skipped: ${r.reason}`);
  errorParts.push(
    `pipeline slices=${r.sliceCount} entries=${r.extractCount} wikiPages=${r.wikiPageCount}`,
  );
  if (typeof r.durationMs === 'number') {
    errorParts.push(`durationMs=${r.durationMs}`);
  }
  if (typeof r.maxChunkDurationMs === 'number') {
    errorParts.push(`maxChunkDurationMs=${r.maxChunkDurationMs}`);
  }
  return {
    taskId: r.taskId,
    materialId: r.materialId,
    success: r.success,
    classificationStatus: null,
    subjectNodeId: null,
    confidence: null,
    error: errorParts.join('; '),
  };
}

async function runTask(task: TaskRow): Promise<WorkerResult> {
  if (task.type === TASK_TYPE_PIPELINE) {
    const r = await executePipelineTask(task);
    return pipelineResultToWorkerResult(r);
  }
  if (task.type === TASK_TYPE_EXTRACT_BATCH) {
    const r = await executeExtractBatchTask(task);
    return pipelineResultToWorkerResult(r);
  }
  return executeTask(task);
}
