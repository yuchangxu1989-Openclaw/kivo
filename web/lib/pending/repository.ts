/**
 * Pending Queue Repository — KIVO Wave 1 / C1 (新版接口)
 *
 * 实现 `/api/pending/{list,accept,reject}` 三个新版端点的 DB 层。
 *
 * 设计要点：
 *   - "entry" 在本路 contract 里指代 materials 表的一行（spec 把待审
 *     分类条目就叫 entry，与 entries 表区分），与现有 A2 调度器写入的
 *     `materials.classification_status ∈ {pending,in_progress,needs_review,
 *     pending_classification}` 完全对齐。
 *   - 不新建 `pending_classifications` 表；与 lib/pending-classifications
 *     的 repository 共享同一份事实源（materials 表 + subject_nodes 表）。
 *     C1 老版接口（/api/pending-classifications）保持不动。
 *   - reject 路径写 personal_state：固定 learner_id=DEFAULT_LEARNER_ID，
 *     evidence_count++，weak_reason 拼接拒绝理由 + 候选 subject 名，作为
 *     C2 personal_state 的"用户偏好"沉淀，供后续 reranker 使用。
 *
 * Spec 锚点：
 *   - FR-CLASSIFY-3.1 / 3.2 / 3.3 / 3.4 / 3.5（list/accept/reject/手动指定/404）
 *   - reports/kivo-wave1-prompt-breakdown-2026-05-24.md §C1
 *   - arc42 §5.2 分类域 / §8.4 pending_classifications 表
 */

import type Database from 'better-sqlite3';

import { openWebDb } from '@/lib/db';
import { DEFAULT_LEARNER_ID } from '@/lib/types/personal-state';
import type {
  AssetKind,
  ClassificationStatus,
  SourceChannel,
} from '@/lib/types/material';

export type PendingErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST';

export class PendingRepoError extends Error {
  constructor(public readonly code: PendingErrorCode, message: string) {
    super(message);
    this.name = 'PendingRepoError';
  }
}

/**
 * classification_status 中代表"待审/待分类"的取值。
 * 与 lib/types/pending-classification.ts 的 PENDING_QUEUE_STATUSES 保持一致。
 */
export const PENDING_STATUSES: readonly string[] = [
  'pending',
  'in_progress',
  'needs_review',
  'pending_classification',
];

const PENDING_PLACEHOLDERS = PENDING_STATUSES.map(() => '?').join(', ');

export interface PendingListFilter {
  /** subject_hint：模糊匹配 suggested_subject_name 或对应 subject_node 名 */
  subjectHint?: string;
  /** source：精确匹配 source_channel */
  source?: string;
  page: number;
  pageSize: number;
}

export interface SubjectBreadcrumb {
  id: string;
  name: string;
  level: number;
}

export interface PendingItem {
  entryId: string;
  title: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  spaceId: string;
  storagePath: string;
  assetKind: AssetKind | null;
  sourceChannel: SourceChannel | null;
  sourceRef: string | null;
  pipelineStatus: string | null;
  classificationStatus: ClassificationStatus;
  classificationConfidence: number | null;
  candidateSubjectId: string | null;
  candidateSubjectName: string | null;
  candidateBreadcrumb: SubjectBreadcrumb[];
  createdAt: string;
  updatedAt: string;
}

export interface PendingListResult {
  items: PendingItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AcceptResult {
  entryId: string;
  subjectId: string;
  classificationStatus: ClassificationStatus;
}

export interface RejectResult {
  entryId: string;
  classificationStatus: ClassificationStatus;
  personalStateUpdated: boolean;
}

interface MaterialRow {
  id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  status: string;
  space_id: string;
  storage_path: string;
  created_at: string;
  updated_at: string;
  subject_node_id: string | null;
  classification_status: string | null;
  classification_confidence: number | null;
  suggested_subject_name: string | null;
  pipeline_status: string | null;
  asset_kind: string | null;
  source_channel: string | null;
  source_ref: string | null;
}

interface SubjectAncestorRow {
  id: string;
  parent_id: string | null;
  name: string;
  level: number | null;
  merged_into: string | null;
}

const COLUMNS = `
  id, file_name, mime_type, file_size, status, space_id, storage_path,
  created_at, updated_at, subject_node_id, classification_status,
  classification_confidence, suggested_subject_name, pipeline_status,
  asset_kind, source_channel, source_ref
`;

export class PendingRepository {
  private readonly db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db ?? openWebDb(false);
  }

  list(filter: PendingListFilter): PendingListResult {
    const page = Math.max(1, Math.floor(filter.page));
    const pageSize = Math.max(1, Math.min(200, Math.floor(filter.pageSize)));
    const offset = (page - 1) * pageSize;

    const where: string[] = [`classification_status IN (${PENDING_PLACEHOLDERS})`];
    const params: unknown[] = [...PENDING_STATUSES];

    if (filter.source && filter.source.trim()) {
      where.push(`source_channel = ?`);
      params.push(filter.source.trim());
    }

    if (filter.subjectHint && filter.subjectHint.trim()) {
      const hint = `%${filter.subjectHint.trim()}%`;
      where.push(`(
        suggested_subject_name LIKE ?
        OR EXISTS (
          SELECT 1 FROM subject_nodes sn
           WHERE sn.id = materials.subject_node_id
             AND sn.name LIKE ?
        )
      )`);
      params.push(hint, hint);
    }

    const whereClause = where.join(' AND ');

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM materials WHERE ${whereClause}`)
        .get(...params) as { c: number }
    ).c;

    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS}
           FROM materials
          WHERE ${whereClause}
          ORDER BY datetime(created_at) DESC, id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset) as MaterialRow[];

    return {
      items: rows.map((row) => this.project(row)),
      total,
      page,
      pageSize,
    };
  }

  accept(entryId: string, subjectId: string): AcceptResult {
    if (!entryId.trim()) {
      throw new PendingRepoError('BAD_REQUEST', 'entry_id is required');
    }
    if (!subjectId.trim()) {
      throw new PendingRepoError('BAD_REQUEST', 'subject_id is required');
    }

    const row = this.fetchOrThrow(entryId);

    if (row.classification_status === 'classified') {
      throw new PendingRepoError(
        'CONFLICT',
        `entry ${entryId} is already classified`,
      );
    }

    this.assertSubjectUsable(subjectId);

    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE materials
            SET subject_node_id = ?,
                classification_status = 'classified',
                pipeline_status = COALESCE(pipeline_status, 'classified'),
                updated_at = ?
          WHERE id = ?`,
      )
      .run(subjectId, now, entryId);

    if (result.changes !== 1) {
      throw new PendingRepoError('NOT_FOUND', `entry ${entryId} not found`);
    }

    return {
      entryId,
      subjectId,
      classificationStatus: 'classified',
    };
  }

  reject(entryId: string, candidateSubjectId?: string, reason?: string): RejectResult {
    if (!entryId.trim()) {
      throw new PendingRepoError('BAD_REQUEST', 'entry_id is required');
    }

    const row = this.fetchOrThrow(entryId);
    if (row.classification_status === 'classified') {
      throw new PendingRepoError(
        'CONFLICT',
        `entry ${entryId} is already classified; cannot reject`,
      );
    }

    const candidateId =
      (candidateSubjectId && candidateSubjectId.trim()) ||
      row.subject_node_id ||
      null;

    let candidateName: string | null = row.suggested_subject_name ?? null;
    if (candidateId) {
      const node = this.db
        .prepare(`SELECT id, name FROM subject_nodes WHERE id = ?`)
        .get(candidateId) as { id: string; name: string } | undefined;
      if (!node) {
        throw new PendingRepoError(
          'BAD_REQUEST',
          `candidate subject ${candidateId} does not exist`,
        );
      }
      candidateName = node.name;
    }

    const now = new Date().toISOString();
    const next: ClassificationStatus = 'pending_classification' as ClassificationStatus;

    const personalStateUpdated = this.db.transaction(() => {
      const updateRes = this.db
        .prepare(
          `UPDATE materials
              SET classification_status = ?,
                  subject_node_id = NULL,
                  suggested_subject_name = NULL,
                  classification_confidence = NULL,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(next, now, entryId);

      if (updateRes.changes !== 1) {
        throw new PendingRepoError('NOT_FOUND', `entry ${entryId} not found`);
      }

      return this.recordRejectionPreference(entryId, candidateId, candidateName, reason);
    })();

    return {
      entryId,
      classificationStatus: next,
      personalStateUpdated,
    };
  }

  private recordRejectionPreference(
    entryId: string,
    candidateSubjectId: string | null,
    candidateSubjectName: string | null,
    reason: string | undefined,
  ): boolean {
    const reasonTrim = reason?.trim() || '';
    const summaryParts: string[] = [`reject:${entryId}`];
    if (candidateSubjectId) {
      summaryParts.push(`candidate=${candidateSubjectId}`);
    }
    if (candidateSubjectName) {
      summaryParts.push(`name=${candidateSubjectName}`);
    }
    if (reasonTrim) {
      summaryParts.push(`reason=${reasonTrim}`);
    }
    const weakReason = summaryParts.join(' | ');

    const lastSeen = Date.now();

    const existing = this.db
      .prepare(
        `SELECT evidence_count FROM personal_state
          WHERE learner_id = ? AND entry_id = ?`,
      )
      .get(DEFAULT_LEARNER_ID, entryId) as { evidence_count: number | null } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE personal_state
              SET evidence_count = COALESCE(evidence_count, 0) + 1,
                  last_seen = ?,
                  weak_reason = ?
            WHERE learner_id = ? AND entry_id = ?`,
        )
        .run(lastSeen, weakReason, DEFAULT_LEARNER_ID, entryId);
    } else {
      this.db
        .prepare(
          `INSERT INTO personal_state
             (learner_id, entry_id, mastery, confidence, evidence_count,
              last_seen, weak_reason)
           VALUES (?, ?, NULL, NULL, 1, ?, ?)`,
        )
        .run(DEFAULT_LEARNER_ID, entryId, lastSeen, weakReason);
    }
    return true;
  }

  private fetchOrThrow(id: string): MaterialRow {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM materials WHERE id = ?`)
      .get(id) as MaterialRow | undefined;
    if (!row) {
      throw new PendingRepoError('NOT_FOUND', `entry ${id} not found`);
    }
    return row;
  }

  private assertSubjectUsable(subjectId: string): void {
    const row = this.db
      .prepare(`SELECT id, merged_into FROM subject_nodes WHERE id = ?`)
      .get(subjectId) as { id: string; merged_into: string | null } | undefined;
    if (!row) {
      throw new PendingRepoError(
        'BAD_REQUEST',
        `subject ${subjectId} does not exist`,
      );
    }
    if (row.merged_into) {
      throw new PendingRepoError(
        'BAD_REQUEST',
        `subject ${subjectId} has been merged into ${row.merged_into}`,
      );
    }
  }

  private buildBreadcrumb(leafId: string | null): SubjectBreadcrumb[] {
    if (!leafId) return [];

    const stmt = this.db.prepare(
      `SELECT id, parent_id, name, level, merged_into
         FROM subject_nodes WHERE id = ?`,
    );

    const hops: SubjectBreadcrumb[] = [];
    const seen = new Set<string>();
    let cursor: string | null = leafId;

    while (cursor && hops.length < 16) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const row = stmt.get(cursor) as SubjectAncestorRow | undefined;
      if (!row) break;
      hops.push({ id: row.id, name: row.name, level: row.level ?? 0 });
      cursor = row.parent_id;
    }
    return hops.reverse();
  }

  private project(row: MaterialRow): PendingItem {
    return {
      entryId: row.id,
      title: row.file_name,
      fileName: row.file_name,
      mimeType: row.mime_type,
      fileSize: row.file_size,
      spaceId: row.space_id,
      storagePath: row.storage_path,
      assetKind: (row.asset_kind as AssetKind | null) ?? null,
      sourceChannel: (row.source_channel as SourceChannel | null) ?? null,
      sourceRef: row.source_ref,
      pipelineStatus: row.pipeline_status ?? row.status,
      classificationStatus:
        (row.classification_status as ClassificationStatus) ?? 'pending',
      classificationConfidence: row.classification_confidence,
      candidateSubjectId: row.subject_node_id,
      candidateSubjectName: row.suggested_subject_name,
      candidateBreadcrumb: this.buildBreadcrumb(row.subject_node_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

let cached: PendingRepository | null = null;
export function getPendingRepository(): PendingRepository {
  if (!cached) cached = new PendingRepository();
  return cached;
}

/** Reset the cached singleton — used by tests after KIVO_DB_PATH overrides. */
export function resetPendingRepositoryForTests(): void {
  cached = null;
}
