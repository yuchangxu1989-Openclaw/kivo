/**
 * Personal State Types — KIVO Wave 1 C2
 *
 * API projection for the `personal_state` table. The current Wave 0 schema
 * stores personal state by `entry_id`; C2 exposes the requested subject-node
 * state API by mapping `subject_node_id` to that key without changing schema.
 */

export const DEFAULT_LEARNER_ID = 'user-default';

export const PERSONAL_STATE_STATUSES = [
  'not-started',
  'learning',
  'mastered',
  'review-needed',
] as const;

export type PersonalStateStatus = (typeof PERSONAL_STATE_STATUSES)[number];

export interface PersonalStateRow {
  learner_id: string;
  entry_id: string;
  mastery: string | null;
  last_seen: number | null;
}

export interface PersonalStateItem {
  learnerId: string;
  subjectNodeId: string;
  status: PersonalStateStatus;
  updatedAt: number | null;
}

export interface PutPersonalStateInput {
  learnerId: string;
  subjectNodeId: string;
  status: PersonalStateStatus;
}

export interface DeletePersonalStateInput {
  learnerId: string;
  subjectNodeId: string;
}

export function isPersonalStateStatus(value: unknown): value is PersonalStateStatus {
  return typeof value === 'string' && PERSONAL_STATE_STATUSES.includes(value as PersonalStateStatus);
}
