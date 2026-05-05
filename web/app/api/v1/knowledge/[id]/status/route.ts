/**
 * PATCH /api/v1/knowledge/:id/status
 * Mark entry as deprecated/active/archived (FR-J02)
 * Implements expectedVersion + requestId + 409 VERSION_CONFLICT protocol
 */

import { NextRequest, NextResponse } from 'next/server';
import { getKivo, persistEntry } from '@/lib/kivo-engine';
import { appendKnowledgeSnapshot, ensureKnowledgeHistory } from '@/lib/knowledge-history';
import { badRequest, notFound, versionConflict, serverError } from '@/lib/errors';
import type { StatusUpdateRequest, WriteResponse } from '@/types';
import type { KnowledgeEntry, EntryStatus } from '@self-evolving-harness/kivo';

const VALID_TARGET_STATUSES: EntryStatus[] = ['deprecated', 'active', 'archived'];

function isTransitionAllowed(from: EntryStatus, to: EntryStatus) {
  if (from === 'pending') return to === 'active' || to === 'archived';
  if (from === 'active') return to === 'deprecated' || to === 'archived';
  if (from === 'deprecated') return to === 'active' || to === 'archived';
  if (from === 'archived') return to === 'active';
  return false;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const body = (await request.json()) as StatusUpdateRequest;

    // Validate required fields
    if (!body.status || !VALID_TARGET_STATUSES.includes(body.status as EntryStatus)) {
      return badRequest(`status must be one of: ${VALID_TARGET_STATUSES.join(', ')}`);
    }
    if (typeof body.expectedVersion !== 'number') {
      return badRequest('expectedVersion is required and must be a number');
    }
    if (!body.requestId || typeof body.requestId !== 'string') {
      return badRequest('requestId is required and must be a string');
    }

    const kivo = await getKivo();
    const entry = await kivo.getEntry(id);

    if (!entry) {
      return notFound(`Knowledge entry not found: ${id}`);
    }

    // Version conflict check
    if (entry.version !== body.expectedVersion) {
      return versionConflict(entry.version, body.expectedVersion, body.requestId);
    }

    if (!isTransitionAllowed(entry.status, body.status as EntryStatus)) {
      return badRequest(`Invalid transition: ${entry.status} -> ${body.status}`);
    }

    ensureKnowledgeHistory(entry);

    // Update status and persist
    const updatedEntry: KnowledgeEntry = {
      ...entry,
      status: body.status as EntryStatus,
      updatedAt: new Date(),
      version: entry.version + 1,
    };

    const saved = await persistEntry(updatedEntry);
    if (!saved) {
      return badRequest('质量门禁拒绝保存该状态变更。');
    }
    appendKnowledgeSnapshot(updatedEntry, `状态从 ${entry.status} 变更为 ${updatedEntry.status}。`);

    const response: WriteResponse<KnowledgeEntry> = {
      data: updatedEntry,
      meta: {
        version: updatedEntry.version,
        requestId: body.requestId,
      },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
