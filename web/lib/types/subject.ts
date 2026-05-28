/**
 * Subject Node Types — KIVO Wave 1 B1
 *
 * Maps to the `subject_nodes` table created in
 * migrations/2026-05-24-wave0-schema.sql. Wave 1 B1 only exposes the
 * subset of columns needed for CRUD + tree rendering. Other columns
 * (aliases, merged_into, confidence, origin) are owned by B2-B5 and
 * the classification pipeline; B1 must not break them.
 *
 * Level semantics:
 *   L0 = domain (root, parent_id must be null)
 *   L1 = topic  (parent must be L0)
 *   L2 = unit   (parent must be L1)
 *
 * Wave 1 B1 caps the tree at L2 to match
 * `docs/product-requirements.md` FR-B03.
 */

export const SUBJECT_LEVEL_DOMAIN = 0;
export const SUBJECT_LEVEL_TOPIC = 1;
export const SUBJECT_LEVEL_UNIT = 2;
export const SUBJECT_MAX_LEVEL = SUBJECT_LEVEL_UNIT;

export type SubjectLevel =
  | typeof SUBJECT_LEVEL_DOMAIN
  | typeof SUBJECT_LEVEL_TOPIC
  | typeof SUBJECT_LEVEL_UNIT;

/** Raw row shape of subject_nodes (only the fields B1 reads/writes). */
export interface SubjectNodeRow {
  id: string;
  parent_id: string | null;
  name: string;
  tree_kind: string;
  origin: string;
  created_by_material_id: string | null;
  created_at: number;
  confidence: number | null;
  aliases: string | null;
  merged_into: string | null;
  level: number | null;
  status: string | null;
  deletable: number | null;
}

/** Flat subject node returned by the API (no children attached). */
export interface SubjectNode {
  id: string;
  parentId: string | null;
  name: string;
  level: SubjectLevel;
  treeKind: string;
  origin: string;
  createdAt: number;
  /** Number of materials directly attached to this node (not recursive). */
  materialCount: number;
  /** A1: true for system root nodes that cannot be deleted. */
  isSystemRoot: boolean;
}

/** Tree node returned by GET /api/subjects (children nested). */
export interface SubjectTreeNode extends SubjectNode {
  children: SubjectTreeNode[];
}

export interface CreateSubjectInput {
  name: string;
  parentId: string | null;
  level: SubjectLevel;
}

export interface UpdateSubjectInput {
  name?: string;
  parentId?: string | null;
}

/** Body for POST /api/subjects/[id]/rename. */
export interface RenameSubjectInput {
  subjectId: string;
  newName: string;
}

/** Body for POST /api/subjects/merge. */
export interface MergeSubjectInput {
  sourceSubjectIds: string[];
  targetSubjectId: string;
}

export interface SplitSubjectTargetInput {
  name: string;
  entryIds: string[];
}

/** Body for POST /api/subjects/split. */
export interface SplitSubjectInput {
  sourceSubjectId: string;
  splits: SplitSubjectTargetInput[];
}

/** Diagnostic counters returned after a merge operation. */
export interface MergeSubjectResult {
  target: SubjectNode;
  sourceSubjectIds: string[];
  movedChildren: number;
  movedEntries: number;
  movedAliases: number;
  movedMaterials: number;
}

export interface SplitSubjectResult {
  sourceSubjectId: string;
  createdSubjects: SubjectNode[];
  movedEntries: number;
  movedMaterials: number;
}
