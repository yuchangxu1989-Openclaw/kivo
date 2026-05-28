/**
 * Queue Worker — KIVO Wave 1 / A2
 *
 * 单任务执行器：从 task_queue 取一条 classify_pending 任务，
 * 调 SubjectClassifier 拿 (subject_id, confidence)，根据结果更新
 * materials 表和 task_queue 状态。
 *
 * AC 覆盖：
 *   AC-CLASSIFY-1.2: 调 SubjectClassifier 得 (subject_id, confidence)
 *   AC-CLASSIFY-2.1: confidence ≥ threshold → entries.status='classified', 写 subject_id
 *   AC-CLASSIFY-2.2: confidence < threshold → entries.status='pending_review', 写 pending_classifications
 *   AC-CLASSIFY-4.1: 失败 retry_count++，达 3 次后 status='failed'
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openWebDb } from '@/lib/db';
import {
  classify,
  CONFIDENCE_THRESHOLD,
  type ClassifyInput,
  type ClassificationResult,
} from '@/lib/classify/subject_classifier';
import { enqueuePipelineTaskForMaterial } from '@/lib/queue/pipeline-worker';

// ─── Constants ───────────────────────────────────────────────────────────────

export const MAX_RETRIES = 3;
export const TASK_STATUS_WAITING = 'waiting';
export const TASK_STATUS_RUNNING = 'running';
export const TASK_STATUS_DONE = 'done';
export const TASK_STATUS_FAILED = 'failed';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TaskRow {
  id: string;
  type: string;
  payload: string;
  status: string;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerResult {
  taskId: string;
  materialId: string;
  success: boolean;
  classificationStatus: string | null;
  subjectNodeId: string | null;
  confidence: number | null;
  error?: string;
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

function markTaskRunning(db: Database.Database, taskId: string): void {
  db.prepare(
    `UPDATE task_queue SET status = 'running', updated_at = datetime('now') WHERE id = ?`,
  ).run(taskId);
}

function markTaskDone(db: Database.Database, taskId: string): void {
  db.prepare(
    `UPDATE task_queue SET status = 'done', updated_at = datetime('now') WHERE id = ?`,
  ).run(taskId);
}

function markTaskFailed(
  db: Database.Database,
  taskId: string,
  error: string,
  retryCount: number,
): void {
  const finalStatus = retryCount >= MAX_RETRIES ? 'failed' : 'waiting';
  db.prepare(
    `UPDATE task_queue
        SET status = @status,
            retry_count = @retryCount,
            last_error = @error,
            updated_at = datetime('now')
      WHERE id = @id`,
  ).run({
    id: taskId,
    status: finalStatus,
    retryCount,
    error,
  });
}

/**
 * 更新 materials 表：高置信度 → classified + subject_node_id
 */
function updateMaterialClassified(
  db: Database.Database,
  materialId: string,
  subjectNodeId: string,
  confidence: number,
  reasoning: string,
  suggestedName: string,
): void {
  db.prepare(
    `UPDATE materials
        SET classification_status = 'classified',
            classification_confidence = @confidence,
            subject_node_id = @subjectNodeId,
            suggested_subject_name = @suggestedName,
            updated_at = datetime('now')
      WHERE id = @id`,
  ).run({
    id: materialId,
    confidence,
    subjectNodeId,
    suggestedName,
  });

  // Also ensure classification_reason column exists and write it
  ensureColumn(db, 'materials', 'classification_reason', 'TEXT');
  db.prepare(
    `UPDATE materials SET classification_reason = ? WHERE id = ?`,
  ).run(reasoning, materialId);
}

/**
 * 更新 materials 表：低置信度 → pending_review (needs_review)
 * 同时写入 pending_classifications 逻辑表（通过 materials 字段实现）
 */
function updateMaterialPendingReview(
  db: Database.Database,
  materialId: string,
  confidence: number,
  reasoning: string,
  suggestedName: string,
  suggestedPath: string[],
): void {
  db.prepare(
    `UPDATE materials
        SET classification_status = 'needs_review',
            classification_confidence = @confidence,
            suggested_subject_name = @suggestedName,
            subject_node_id = NULL,
            updated_at = datetime('now')
      WHERE id = @id`,
  ).run({
    id: materialId,
    confidence,
    suggestedName,
  });

  ensureColumn(db, 'materials', 'classification_reason', 'TEXT');
  db.prepare(
    `UPDATE materials SET classification_reason = ? WHERE id = ?`,
  ).run(reasoning, materialId);
}

/**
 * 更新 materials 表：分类失败
 */
function updateMaterialFailed(
  db: Database.Database,
  materialId: string,
  error: string,
): void {
  db.prepare(
    `UPDATE materials
        SET classification_status = 'failed',
            updated_at = datetime('now')
      WHERE id = @id`,
  ).run({ id: materialId });

  ensureColumn(db, 'materials', 'classification_reason', 'TEXT');
  db.prepare(
    `UPDATE materials SET classification_reason = ? WHERE id = ?`,
  ).run(`分类失败: ${error}`, materialId);
}

/**
 * 确保 subject 存在根节点。幂等：已存在则返回现有节点 ID。
 * 用于 FR-B03 AC2：识别出的学科域如果不存在 → 自动创建新学科树根节点。
 */
function ensureSubjectRootNode(
  db: Database.Database,
  name: string,
  materialId: string,
  confidence: number,
): string {
  const normalizedName = name.trim();
  const existing = db
    .prepare(
      `SELECT id FROM subject_nodes
       WHERE name = ? AND parent_id IS NULL AND merged_into IS NULL
       LIMIT 1`,
    )
    .get(normalizedName) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO subject_nodes
       (id, parent_id, name, tree_kind, origin, created_by_material_id,
        created_at, confidence, level)
     VALUES (?, NULL, ?, 'subject', 'auto', ?, ?, ?, 0)`,
  ).run(id, normalizedName, materialId, now, confidence);
  return id;
}

/**
 * LLM 学科输出动态 upsert。当前按 name exact match 归并；LLM 同义判定留作后续需求。
 */
function upsertSubjectRootNodeByName(
  db: Database.Database,
  name: string,
  materialId: string,
  confidence: number,
): string {
  return ensureSubjectRootNode(db, name, materialId, confidence);
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (!rows.some((r) => r.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// ─── Worker main ─────────────────────────────────────────────────────────────

/**
 * 执行单条 classify_pending 任务。
 *
 * 流程：
 *   1. 标记 task running
 *   2. 从 payload 取 materialId
 *   3. 从 materials 表读 content（file_name 作为 title/content 代理）
 *   4. 调 SubjectClassifier
 *   5. 根据 confidence 分流写回
 *   6. 标记 task done / failed
 */
export async function executeTask(task: TaskRow): Promise<WorkerResult> {
  const db = openWebDb(false);

  try {
    // Parse payload
    let payload: { materialId: string; content?: string };
    try {
      payload = JSON.parse(task.payload);
    } catch {
      const error = `Invalid task payload: ${task.payload?.slice(0, 100)}`;
      markTaskFailed(db, task.id, error, task.retry_count + 1);
      return {
        taskId: task.id,
        materialId: '',
        success: false,
        classificationStatus: null,
        subjectNodeId: null,
        confidence: null,
        error,
      };
    }

    const { materialId } = payload;

    // Mark running
    markTaskRunning(db, task.id);

    // Update material status to in_progress
    db.prepare(
      `UPDATE materials SET classification_status = 'in_progress', updated_at = datetime('now') WHERE id = ?`,
    ).run(materialId);

    // Get material content for classification
    const materialRow = db
      .prepare(
        `SELECT id, file_name, asset_kind, source_ref, source_channel, storage_path
           FROM materials WHERE id = ?`,
      )
      .get(materialId) as
      | {
          id: string;
          file_name: string;
          asset_kind: string | null;
          source_ref: string | null;
          source_channel: string | null;
          storage_path: string | null;
        }
      | undefined;

    if (!materialRow) {
      const error = `Material ${materialId} not found`;
      markTaskFailed(db, task.id, error, task.retry_count + 1);
      return {
        taskId: task.id,
        materialId,
        success: false,
        classificationStatus: null,
        subjectNodeId: null,
        confidence: null,
        error,
      };
    }

    // Build content for classification: use title + asset_kind + source info
    // In a full implementation, we'd read the actual file content. For Wave 1,
    // we use the available metadata as the classification input.
    const contentParts = [
      materialRow.file_name || '',
      materialRow.asset_kind ? `类型: ${materialRow.asset_kind}` : '',
      materialRow.source_ref ? `来源: ${materialRow.source_ref}` : '',
      materialRow.source_channel
        ? `渠道: ${materialRow.source_channel}`
        : '',
      payload.content || '',
    ].filter(Boolean);

    const classifyInput: ClassifyInput = {
      materialId,
      content: contentParts.join('\n'),
    };

    // Call SubjectClassifier
    let result: ClassificationResult;
    try {
      result = await classify(classifyInput, { db });
    } catch (err) {
      const error = `SubjectClassifier error: ${(err as Error).message}`;
      const newRetry = task.retry_count + 1;
      markTaskFailed(db, task.id, error, newRetry);

      if (newRetry >= MAX_RETRIES) {
        updateMaterialFailed(db, materialId, error);
      } else {
        // Revert to pending so next tick picks it up
        db.prepare(
          `UPDATE materials SET classification_status = 'pending', updated_at = datetime('now') WHERE id = ?`,
        ).run(materialId);
      }

      return {
        taskId: task.id,
        materialId,
        success: false,
        classificationStatus: newRetry >= MAX_RETRIES ? 'failed' : 'pending',
        subjectNodeId: null,
        confidence: null,
        error,
      };
    }

    // Route based on classification result
    if (result.classificationStatus === 'extract_failed') {
      const error = result.meta.error || 'Classification extraction failed';
      const newRetry = task.retry_count + 1;
      markTaskFailed(db, task.id, error, newRetry);

      if (newRetry >= MAX_RETRIES) {
        updateMaterialFailed(db, materialId, error);
        return {
          taskId: task.id,
          materialId,
          success: false,
          classificationStatus: 'failed',
          subjectNodeId: null,
          confidence: null,
          error,
        };
      }

      // Revert to pending for retry
      db.prepare(
        `UPDATE materials SET classification_status = 'pending', updated_at = datetime('now') WHERE id = ?`,
      ).run(materialId);

      return {
        taskId: task.id,
        materialId,
        success: false,
        classificationStatus: 'pending',
        subjectNodeId: null,
        confidence: null,
        error,
      };
    }

    if (
      result.classificationStatus === 'auto_assigned' &&
      result.subjectNodeId
    ) {
      // AC-CLASSIFY-2.1: High confidence → classified. The subject may come
      // from an existing node; upsert by LLM name keeps fresh installs dynamic
      // and exact-match idempotent without relying on any seed subject list.
      const dynamicSubjectNodeId = upsertSubjectRootNodeByName(
        db,
        result.subjectDomain,
        materialId,
        result.confidence,
      );
      updateMaterialClassified(
        db,
        materialId,
        dynamicSubjectNodeId,
        result.confidence,
        result.reasoning,
        result.subjectDomain,
      );
      // FR-A02: 分类完成立刻给该 material 入队 process_pipeline
      try {
        enqueuePipelineTaskForMaterial(db, materialId);
      } catch {
        /* enqueue 失败不应阻塞 classify 主路径，下次 backfill 兜底 */
      }
      markTaskDone(db, task.id);

      return {
        taskId: task.id,
        materialId,
        success: true,
        classificationStatus: 'classified',
        subjectNodeId: dynamicSubjectNodeId,
        confidence: result.confidence,
      };
    }

    // FR-B03 AC2: New domain with high confidence → create root node + classified
    if (result.isNewDomain && result.confidence >= CONFIDENCE_THRESHOLD) {
      const nodeId = upsertSubjectRootNodeByName(
        db,
        result.subjectDomain,
        materialId,
        result.confidence,
      );
      updateMaterialClassified(
        db,
        materialId,
        nodeId,
        result.confidence,
        result.reasoning,
        result.subjectDomain,
      );
      try {
        enqueuePipelineTaskForMaterial(db, materialId);
      } catch {
        /* fall through to next backfill tick */
      }
      markTaskDone(db, task.id);

      return {
        taskId: task.id,
        materialId,
        success: true,
        classificationStatus: 'classified',
        subjectNodeId: nodeId,
        confidence: result.confidence,
      };
    }

    // AC-CLASSIFY-2.2: Low confidence → pending_review
    updateMaterialPendingReview(
      db,
      materialId,
      result.confidence,
      result.reasoning,
      result.subjectDomain,
      result.suggestedPath,
    );
    markTaskDone(db, task.id);

    return {
      taskId: task.id,
      materialId,
      success: true,
      classificationStatus: 'needs_review',
      subjectNodeId: null,
      confidence: result.confidence,
    };
  } finally {
    db.close();
  }
}
