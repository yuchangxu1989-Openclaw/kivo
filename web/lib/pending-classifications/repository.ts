/**
 * Pending Classifications Repository — KIVO Wave 1 / C1
 *
 * Materialises the "pending classification" queue on top of the
 * existing `materials` + `subject_nodes` tables. No schema changes.
 *
 * Responsibilities:
 *   - list rows whose classification_status is in PENDING_QUEUE_STATUSES,
 *     ordered newest-first, with the suggested subject's breadcrumb.
 *   - confirm one row → set classification_status='classified',
 *     subject_node_id=<chosen>, leave the queue.
 *   - reject one row → keep it in the queue under
 *     classification_status='pending_classification', clear the
 *     suggestion fields so A2 will re-score on next dispatcher tick.
 *
 * SQL is kept thin and explicit; we don't share the heavy machinery in
 * SubjectRepository because C1's needs are simpler (read-only joins
 * + targeted updates) and we want each route to be auditable on its own.
 */

import type Database from 'better-sqlite3';

import { openWebDb } from '@/lib/db';
import {
  PENDING_QUEUE_STATUSES,
  type ConfirmPendingResult,
  type PendingClassificationItem,
  type RejectPendingResult,
  type SubjectBreadcrumbHop,
} from '@/lib/types/pending-classification';
import type {
  AssetKind,
  ClassificationStatus,
  SourceChannel,
} from '@/lib/types/material';

export type PendingRepoErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST';

export class PendingRepoError extends Error {
  constructor(
    public readonly code: PendingRepoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PendingRepoError';
  }
}

interface MaterialPendingRow {
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

const QUEUE_PLACEHOLDERS = PENDING_QUEUE_STATUSES.map(() => '?').join(', ');

export class PendingClassificationsRepository {
  private readonly db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db ?? openWebDb(false);
  }

  /**
   * List every material currently in the pending queue, newest first.
   * The breadcrumb is walked using a per-row recursive lookup; queue
   * sizes are expected to be small (CEO Web review backlog), so an
   * O(N × depth) walk is fine and avoids a CTE that would diverge from
   * the rest of the codebase's plain-SQL style.
   */
  list(): PendingClassificationItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, file_name, mime_type, file_size, status, space_id,
                storage_path, created_at, updated_at, subject_node_id,
                classification_status, classification_confidence,
                suggested_subject_name, pipeline_status,
                asset_kind, source_channel, source_ref
           FROM materials
          WHERE classification_status IN (${QUEUE_PLACEHOLDERS})
          ORDER BY datetime(created_at) DESC, id ASC`,
      )
      .all(...PENDING_QUEUE_STATUSES) as MaterialPendingRow[];

    return rows.map((row) => this.projectItem(row));
  }

  /**
   * Confirm a pending row: pin it to a subject node and mark it
   * `classified`. When `subjectNodeId` is omitted we reuse whatever
   * suggestion A2 wrote into materials.subject_node_id.
   *
   * Validates that the chosen subject node exists and is not merged
   * away. Idempotent on repeat (already-classified rows return 409 so
   * the UI can refresh stale state).
   */
  confirm(materialId: string, subjectNodeId: string | undefined): ConfirmPendingResult {
    const row = this.fetchOrThrow(materialId);

    if (row.classification_status === 'classified') {
      throw new PendingRepoError(
        'CONFLICT',
        `material ${materialId} is already classified`,
      );
    }

    const chosen = subjectNodeId ?? row.subject_node_id ?? null;
    if (!chosen) {
      throw new PendingRepoError(
        'BAD_REQUEST',
        'subjectNodeId is required when the material has no suggested subject',
      );
    }

    this.assertSubjectUsable(chosen);

    const now = new Date().toISOString();
    const result = this.db.transaction(() => {
      const updateResult = this.db
        .prepare(
          `UPDATE materials
              SET subject_node_id = ?,
                  classification_status = 'classified',
                  pipeline_status = COALESCE(pipeline_status, 'classified'),
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(chosen, now, materialId);

      if (updateResult.changes !== 1) {
        throw new PendingRepoError('NOT_FOUND', `material ${materialId} not found`);
      }

      this.backfillEntrySubjectsForMaterial(materialId, chosen, now);

      return updateResult;
    })();

    if (result.changes !== 1) {
      throw new PendingRepoError('NOT_FOUND', `material ${materialId} not found`);
    }

    return {
      materialId,
      classificationStatus: 'classified',
      subjectNodeId: chosen,
    };
  }

  /**
   * Reject the current suggestion and drop the row back into the queue
   * for A2 to re-score. We clear subject_node_id / suggested name /
   * confidence so the dispatcher's idempotent guards don't think the
   * row is already classified.
   */
  reject(materialId: string): RejectPendingResult {
    const row = this.fetchOrThrow(materialId);

    if (row.classification_status === 'classified') {
      throw new PendingRepoError(
        'CONFLICT',
        `material ${materialId} is already classified; cannot reject`,
      );
    }

    const now = new Date().toISOString();
    const next: ClassificationStatus = 'pending_classification' as ClassificationStatus;
    const result = this.db
      .prepare(
        `UPDATE materials
            SET classification_status = ?,
                subject_node_id = NULL,
                suggested_subject_name = NULL,
                classification_confidence = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(next, now, materialId);

    if (result.changes !== 1) {
      throw new PendingRepoError('NOT_FOUND', `material ${materialId} not found`);
    }

    return {
      materialId,
      classificationStatus: next,
    };
  }

  /* --------------------------- private helpers --------------------------- */

  private backfillEntrySubjectsForMaterial(materialId: string, subjectNodeId: string, now: string): void {
    const entriesTable = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'`)
      .get() as { name: string } | undefined;
    if (!entriesTable) return;

    const columns = this.db.prepare(`PRAGMA table_info(entries)`).all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has('subject_id') || !columnNames.has('source_json')) return;

    const hasUpdatedAt = columnNames.has('updated_at');
    const hasMetadataJson = columnNames.has('metadata_json');
    const metadataPredicate = hasMetadataJson
      ? `OR EXISTS (
           SELECT 1
             FROM json_each(COALESCE(json_extract(metadata_json, '$.domainData.materialIds'), '[]'))
            WHERE json_each.value = @materialId
         )`
      : '';
    const updatedAtAssignment = hasUpdatedAt ? `, updated_at = @now` : '';

    this.db
      .prepare(
        `UPDATE entries
            SET subject_id = @subjectNodeId${updatedAtAssignment}
          WHERE subject_id IS NULL
            AND (
              json_extract(source_json, '$.materialId') = @materialId
              OR EXISTS (
                SELECT 1
                  FROM json_each(COALESCE(json_extract(source_json, '$.materialIds'), '[]'))
                 WHERE json_each.value = @materialId
              )
              ${metadataPredicate}
            )`,
      )
      .run({ subjectNodeId, now, materialId });
  }

  private fetchOrThrow(id: string): MaterialPendingRow {
    const row = this.db
      .prepare(
        `SELECT id, file_name, mime_type, file_size, status, space_id,
                storage_path, created_at, updated_at, subject_node_id,
                classification_status, classification_confidence,
                suggested_subject_name, pipeline_status,
                asset_kind, source_channel, source_ref
           FROM materials
          WHERE id = ?`,
      )
      .get(id) as MaterialPendingRow | undefined;
    if (!row) {
      throw new PendingRepoError('NOT_FOUND', `material ${id} not found`);
    }
    return row;
  }

  private assertSubjectUsable(subjectNodeId: string): void {
    const row = this.db
      .prepare(`SELECT id, merged_into FROM subject_nodes WHERE id = ?`)
      .get(subjectNodeId) as { id: string; merged_into: string | null } | undefined;

    if (!row) {
      throw new PendingRepoError(
        'BAD_REQUEST',
        `subject node ${subjectNodeId} does not exist`,
      );
    }
    if (row.merged_into) {
      throw new PendingRepoError(
        'BAD_REQUEST',
        `subject node ${subjectNodeId} has been merged into ${row.merged_into}`,
      );
    }
  }

  /**
   * Walk parent_id from leaf to root (capped at 16 hops to defend
   * against legacy cyclic data). Returns the hops in root-first order,
   * matching the breadcrumb display convention.
   */
  private buildBreadcrumb(leafId: string | null): SubjectBreadcrumbHop[] {
    if (!leafId) return [];

    const stmt = this.db.prepare(
      `SELECT id, parent_id, name, level, merged_into
         FROM subject_nodes
        WHERE id = ?`,
    );

    const hops: SubjectBreadcrumbHop[] = [];
    const seen = new Set<string>();
    let cursor: string | null = leafId;

    while (cursor && hops.length < 16) {
      if (seen.has(cursor)) break; // pre-existing cycle: bail
      seen.add(cursor);

      const row = stmt.get(cursor) as SubjectAncestorRow | undefined;
      if (!row) break;

      hops.push({ id: row.id, name: row.name, level: row.level ?? 0 });
      cursor = row.parent_id;
    }

    return hops.reverse();
  }

  private projectItem(row: MaterialPendingRow): PendingClassificationItem {
    const breadcrumb = this.buildBreadcrumb(row.subject_node_id);
    return {
      id: row.id,
      materialId: row.id,
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
      classificationStatus: (row.classification_status as ClassificationStatus) ?? 'pending',
      classificationConfidence: row.classification_confidence,
      suggestedSubjectNodeId: row.subject_node_id,
      suggestedSubjectName: row.suggested_subject_name,
      suggestedSubjectBreadcrumb: breadcrumb,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

let cachedRepo: PendingClassificationsRepository | null = null;
export function getPendingClassificationsRepository(): PendingClassificationsRepository {
  if (!cachedRepo) cachedRepo = new PendingClassificationsRepository();
  return cachedRepo;
}
