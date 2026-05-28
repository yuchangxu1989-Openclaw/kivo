/**
 * Pending Classification Types — KIVO Wave 1 / C1
 *
 * Represents an item in the "等待人工/AI 确认归位" queue. Spec reference:
 * docs/architecture/arc42-architecture.md §5.3.1 (SubjectClassifier 阈值与路由)
 * + reports/kivo-wave1-prompt-breakdown-2026-05-24.md §C1.
 *
 * The queue is materialised on top of the existing `materials` table —
 * we do not add a separate `pending_classifications` table. A row is in
 * the queue iff its `classification_status` is one of:
 *   - 'pending'                — A1 just ingested, A2 hasn't run yet
 *   - 'in_progress'            — A2 is currently scoring
 *   - 'needs_review'           — A2 finished but confidence < threshold
 *   - 'pending_classification' — re-queued (e.g. user rejected the
 *                                 suggestion, or split fallback)
 *
 * Once a queue row is `confirm`-ed it transitions to `classified` and
 * leaves the queue. Reject puts it back to `pending_classification`
 * (with the suggestion cleared) so A2 can re-score it later.
 */

import type { AssetKind, ClassificationStatus, SourceChannel } from './material';

/** classification_status values that surface in the pending queue. */
export const PENDING_QUEUE_STATUSES: readonly ClassificationStatus[] = [
  'pending',
  'in_progress',
  'needs_review',
  'pending_classification' as ClassificationStatus,
] as const;

/** Single hop on the breadcrumb path of a suggested subject. */
export interface SubjectBreadcrumbHop {
  id: string;
  name: string;
  level: number;
}

/**
 * One row in the pending queue, exposed by GET /api/pending-classifications.
 *
 * Carries the full material projection plus the suggested subject node
 * (if A2 wrote one) and its breadcrumb path so the UI can render the
 * suggestion in context without an extra round-trip per item.
 */
export interface PendingClassificationItem {
  /** Same as material.id; this is what callers pass to confirm/reject. */
  id: string;

  /* ---- Material projection ---- */
  materialId: string;
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

  /* ---- Suggestion from A2 (may all be null when A2 hasn't run) ---- */
  suggestedSubjectNodeId: string | null;
  suggestedSubjectName: string | null;
  /** Root → leaf path of the suggested subject. Empty when no suggestion. */
  suggestedSubjectBreadcrumb: SubjectBreadcrumbHop[];

  createdAt: string;
  updatedAt: string;
}

/** Request body for POST /api/pending-classifications/[id]/confirm. */
export interface ConfirmPendingInput {
  /**
   * Override the suggestion. When omitted, falls back to the
   * material's existing `subject_node_id` (i.e. the A2 suggestion).
   */
  subjectNodeId?: string;
}

/** Result returned by confirm/reject endpoints. */
export interface ConfirmPendingResult {
  materialId: string;
  classificationStatus: ClassificationStatus;
  subjectNodeId: string;
}

export interface RejectPendingResult {
  materialId: string;
  classificationStatus: ClassificationStatus;
}
