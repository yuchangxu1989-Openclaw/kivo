/**
 * Subject Validator — KIVO Wave 1 B1
 *
 * Pure validation helpers. No DB access; the repository handles
 * existence / uniqueness / foreign-key checks because those need a
 * live SQLite handle.
 *
 * Rules enforced here (cheap, no DB):
 *   - name: required, non-empty after trim, max 120 chars (matches
 *     spec FR-B03 — long enough for "主题域 / 章节名 / 核心概念" style
 *     names).
 *   - level: must be 0, 1 or 2 (L0 domain / L1 topic / L2 unit).
 *   - parent/level coherence: L0 must have null parent; L1 / L2 must
 *     have non-null parent. (Parent's actual level is verified in the
 *     repository against DB state.)
 */

import {
  SUBJECT_LEVEL_DOMAIN,
  SUBJECT_LEVEL_TOPIC,
  SUBJECT_LEVEL_UNIT,
  SUBJECT_MAX_LEVEL,
  type CreateSubjectInput,
  type MergeSubjectInput,
  type RenameSubjectInput,
  type SplitSubjectInput,
  type SubjectLevel,
  type UpdateSubjectInput,
} from '@/lib/types/subject';

const NAME_MAX = 120;

export interface ValidationError {
  code: 'BAD_REQUEST';
  message: string;
}

function makeErr(message: string): ValidationError {
  return { code: 'BAD_REQUEST', message };
}

export function isSubjectLevel(v: unknown): v is SubjectLevel {
  return (
    v === SUBJECT_LEVEL_DOMAIN ||
    v === SUBJECT_LEVEL_TOPIC ||
    v === SUBJECT_LEVEL_UNIT
  );
}

/** Validates a body for POST /api/subjects. */
export function validateCreateInput(body: unknown):
  | { ok: true; value: CreateSubjectInput }
  | { ok: false; error: ValidationError } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: makeErr('request body must be a JSON object') };
  }
  const raw = body as Record<string, unknown>;

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    return { ok: false, error: makeErr('name is required') };
  }
  if (name.length > NAME_MAX) {
    return { ok: false, error: makeErr(`name must be ≤ ${NAME_MAX} chars`) };
  }

  if (!('level' in raw)) {
    return { ok: false, error: makeErr('level is required (0=domain, 1=topic, 2=unit)') };
  }
  if (!isSubjectLevel(raw.level)) {
    return {
      ok: false,
      error: makeErr(`level must be 0, 1 or ${SUBJECT_MAX_LEVEL}`),
    };
  }

  // parent_id may be omitted for L0; explicit null is also fine.
  let parentId: string | null;
  if (raw.parent_id === undefined || raw.parent_id === null) {
    parentId = null;
  } else if (typeof raw.parent_id === 'string' && raw.parent_id.trim().length > 0) {
    parentId = raw.parent_id.trim();
  } else {
    return { ok: false, error: makeErr('parent_id must be a non-empty string or null') };
  }

  if (raw.level === SUBJECT_LEVEL_DOMAIN && parentId !== null) {
    return { ok: false, error: makeErr('L0 (domain) nodes must have parent_id = null') };
  }
  if (raw.level !== SUBJECT_LEVEL_DOMAIN && parentId === null) {
    return { ok: false, error: makeErr('L1/L2 nodes require a parent_id') };
  }

  return {
    ok: true,
    value: {
      name,
      parentId,
      level: raw.level,
    },
  };
}

/** Validates a body for PATCH /api/subjects/[id]. */
export function validateUpdateInput(body: unknown):
  | { ok: true; value: UpdateSubjectInput }
  | { ok: false; error: ValidationError } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: makeErr('request body must be a JSON object') };
  }
  const raw = body as Record<string, unknown>;

  const result: UpdateSubjectInput = {};

  if ('name' in raw) {
    if (typeof raw.name !== 'string') {
      return { ok: false, error: makeErr('name must be a string') };
    }
    const name = raw.name.trim();
    if (!name) {
      return { ok: false, error: makeErr('name cannot be empty') };
    }
    if (name.length > NAME_MAX) {
      return { ok: false, error: makeErr(`name must be ≤ ${NAME_MAX} chars`) };
    }
    result.name = name;
  }

  if ('parent_id' in raw) {
    if (raw.parent_id === null) {
      result.parentId = null;
    } else if (typeof raw.parent_id === 'string' && raw.parent_id.trim().length > 0) {
      result.parentId = raw.parent_id.trim();
    } else {
      return { ok: false, error: makeErr('parent_id must be a non-empty string or null') };
    }
  }

  if (result.name === undefined && result.parentId === undefined) {
    return { ok: false, error: makeErr('at least one of name or parent_id must be provided') };
  }

  return { ok: true, value: result };
}

/** Validates a body for POST /api/subjects/[id]/rename. */
export function validateRenameInput(body: unknown):
  | { ok: true; value: RenameSubjectInput }
  | { ok: false; error: ValidationError } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: makeErr('request body must be a JSON object') };
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.subject_id !== 'string' || raw.subject_id.trim().length === 0) {
    return { ok: false, error: makeErr('subject_id is required') };
  }
  if (typeof raw.new_name !== 'string') {
    return { ok: false, error: makeErr('new_name must be a string') };
  }
  const newName = raw.new_name.trim();
  if (!newName) {
    return { ok: false, error: makeErr('new_name cannot be empty') };
  }
  if (newName.length > NAME_MAX) {
    return { ok: false, error: makeErr(`name must be ≤ ${NAME_MAX} chars`) };
  }
  return {
    ok: true,
    value: {
      subjectId: raw.subject_id.trim(),
      newName,
    },
  };
}

/** Validates a body for POST /api/subjects/merge. */
export function validateMergeInput(body: unknown):
  | { ok: true; value: MergeSubjectInput }
  | { ok: false; error: ValidationError } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: makeErr('request body must be a JSON object') };
  }
  const raw = body as Record<string, unknown>;

  if (!Array.isArray(raw.source_subject_ids) || raw.source_subject_ids.length === 0) {
    return { ok: false, error: makeErr('source_subject_ids must be a non-empty array') };
  }
  const sourceSubjectIds = raw.source_subject_ids
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
  if (sourceSubjectIds.length !== raw.source_subject_ids.length) {
    return { ok: false, error: makeErr('source_subject_ids must contain non-empty strings only') };
  }
  if (typeof raw.target_subject_id !== 'string' || raw.target_subject_id.trim().length === 0) {
    return { ok: false, error: makeErr('target_subject_id is required') };
  }

  return {
    ok: true,
    value: {
      sourceSubjectIds,
      targetSubjectId: raw.target_subject_id.trim(),
    },
  };
}

/** Validates a body for POST /api/subjects/split. */
export function validateSplitInput(body: unknown):
  | { ok: true; value: SplitSubjectInput }
  | { ok: false; error: ValidationError } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: makeErr('request body must be a JSON object') };
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.source_subject_id !== 'string' || raw.source_subject_id.trim().length === 0) {
    return { ok: false, error: makeErr('source_subject_id is required') };
  }
  if (!Array.isArray(raw.splits) || raw.splits.length === 0) {
    return { ok: false, error: makeErr('splits must be a non-empty array') };
  }

  const splits = [];
  for (const split of raw.splits) {
    if (!split || typeof split !== 'object') {
      return { ok: false, error: makeErr('each split must be an object') };
    }
    const record = split as Record<string, unknown>;
    if (typeof record.name !== 'string') {
      return { ok: false, error: makeErr('split name must be a string') };
    }
    const name = record.name.trim();
    if (!name) {
      return { ok: false, error: makeErr('split name cannot be empty') };
    }
    if (name.length > NAME_MAX) {
      return { ok: false, error: makeErr(`name must be ≤ ${NAME_MAX} chars`) };
    }
    if (!Array.isArray(record.entry_ids)) {
      return { ok: false, error: makeErr('split entry_ids must be an array') };
    }
    const entryIds = record.entry_ids
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value) => value.length > 0);
    if (entryIds.length !== record.entry_ids.length) {
      return { ok: false, error: makeErr('split entry_ids must contain non-empty strings only') };
    }
    splits.push({ name, entryIds });
  }

  return {
    ok: true,
    value: {
      sourceSubjectId: raw.source_subject_id.trim(),
      splits,
    },
  };
}
