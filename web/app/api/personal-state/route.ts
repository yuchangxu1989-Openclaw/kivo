/**
 * GET    /api/personal-state — list one learner's subject-node learning states
 * PUT    /api/personal-state — create/update one subject-node learning state
 * DELETE /api/personal-state — remove one subject-node learning state
 *
 * KIVO Wave 1 C2 — spec FR-W04 + FR-B03 learner_id dimension.
 */

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';

import { openWebDb } from '@/lib/db';
import { badRequest, serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';
import {
  DEFAULT_LEARNER_ID,
  isPersonalStateStatus,
  type DeletePersonalStateInput,
  type PersonalStateItem,
  type PersonalStateRow,
  type PutPersonalStateInput,
} from '@/lib/types/personal-state';

export async function GET(request: NextRequest) {
  const learnerId = normalizeLearnerId(request.nextUrl.searchParams.get('learner_id'));

  try {
    const db = openWebDb(true);
    const rows = db
      .prepare<[string]>(
        `SELECT learner_id, entry_id, mastery, last_seen
           FROM personal_state
          WHERE learner_id = ?
          ORDER BY last_seen DESC, entry_id ASC`,
      )
      .all(learnerId) as PersonalStateRow[];

    const data = rows
      .map(rowToItem)
      .filter((item): item is PersonalStateItem => item !== null);

    const response: ApiResponse<PersonalStateItem[]> = {
      data,
      meta: { total: data.length, page: 1, pageSize: data.length },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function PUT(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('request body must be valid JSON');
  }

  const parsed = parsePutInput(body);
  if (!parsed.ok) return badRequest(parsed.error);

  try {
    const now = Date.now();
    const db = openWebDb(false);
    db.prepare(
      `INSERT INTO personal_state (learner_id, entry_id, mastery, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(learner_id, entry_id) DO UPDATE SET
         mastery = excluded.mastery,
         last_seen = excluded.last_seen`,
    ).run(parsed.value.learnerId, parsed.value.subjectNodeId, parsed.value.status, now);

    const data: PersonalStateItem = {
      learnerId: parsed.value.learnerId,
      subjectNodeId: parsed.value.subjectNodeId,
      status: parsed.value.status,
      updatedAt: now,
    };
    return NextResponse.json({ data });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function DELETE(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('request body must be valid JSON');
  }

  const parsed = parseDeleteInput(body);
  if (!parsed.ok) return badRequest(parsed.error);

  try {
    const db = openWebDb(false);
    const info = db
      .prepare<[string, string]>(
        `DELETE FROM personal_state
          WHERE learner_id = ?
            AND entry_id = ?`,
      )
      .run(parsed.value.learnerId, parsed.value.subjectNodeId);

    return NextResponse.json({
      data: {
        learnerId: parsed.value.learnerId,
        subjectNodeId: parsed.value.subjectNodeId,
        deleted: info.changes > 0,
      },
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

function normalizeLearnerId(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_LEARNER_ID;
}

function normalizeStringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim();
}

function parsePutInput(body: unknown):
  | { ok: true; value: PutPersonalStateInput }
  | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: 'request body must be an object' };

  const subjectNodeId = normalizeStringField(body, 'subject_node_id');
  if (!subjectNodeId) return { ok: false, error: 'subject_node_id is required' };

  const status = body.status;
  if (!isPersonalStateStatus(status)) {
    return {
      ok: false,
      error: 'status must be one of: not-started, learning, mastered, review-needed',
    };
  }

  return {
    ok: true,
    value: {
      learnerId: normalizeLearnerId(body.learner_id),
      subjectNodeId,
      status,
    },
  };
}

function parseDeleteInput(body: unknown):
  | { ok: true; value: DeletePersonalStateInput }
  | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: 'request body must be an object' };

  const subjectNodeId = normalizeStringField(body, 'subject_node_id');
  if (!subjectNodeId) return { ok: false, error: 'subject_node_id is required' };

  return {
    ok: true,
    value: {
      learnerId: normalizeLearnerId(body.learner_id),
      subjectNodeId,
    },
  };
}

function rowToItem(row: PersonalStateRow): PersonalStateItem | null {
  if (!isPersonalStateStatus(row.mastery)) return null;
  return {
    learnerId: row.learner_id,
    subjectNodeId: row.entry_id,
    status: row.mastery,
    updatedAt: row.last_seen,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
