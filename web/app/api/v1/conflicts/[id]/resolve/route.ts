/**
 * POST /api/v1/conflicts/:id/resolve
 * Submit conflict resolution (FR-H02 AC2)
 * Implements expectedVersion + requestId + 409 VERSION_CONFLICT protocol
 */

import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, versionConflict, serverError } from '@/lib/errors';
import { resolveConflictRecord } from '@/lib/domain-stores';
import type { ConflictRecordView } from '@/lib/domain-stores';
import type { ConflictResolveRequest, WriteResponse } from '@/types';

const VALID_STRATEGIES = ['newer-wins', 'confidence-wins', 'manual', 'keep-a', 'keep-b', 'merge', 'archive-both'] as const;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const body = (await request.json()) as ConflictResolveRequest;

    if (!body.strategy || !VALID_STRATEGIES.includes(body.strategy)) {
      return badRequest(`strategy must be one of: ${VALID_STRATEGIES.join(', ')}`);
    }
    if (typeof body.expectedVersion !== 'number') {
      return badRequest('expectedVersion is required and must be a number');
    }
    if (!body.requestId || typeof body.requestId !== 'string') {
      return badRequest('requestId is required and must be a string');
    }
    if (body.strategy === 'manual' && !body.winnerId) {
      return badRequest('winnerId is required when strategy is manual');
    }

    const operator = typeof body.operator === 'string' && body.operator.trim() ? body.operator.trim() : '当前用户';
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : '';

    if (['manual', 'keep-a', 'keep-b', 'merge', 'archive-both'].includes(body.strategy) && !reason) {
      return badRequest('reason is required for manual resolution strategies');
    }

    const normalizedStrategy = body.strategy === 'manual'
      ? body.winnerId
        ? 'keep-a'
        : 'keep-b'
      : body.strategy;

    try {
      const result: ConflictRecordView | null = resolveConflictRecord({
        id,
        strategy: normalizedStrategy as 'keep-a' | 'keep-b' | 'merge' | 'archive-both',
        operator,
        reason,
        mergedContent: body.mergedContent,
        expectedVersion: body.expectedVersion,
      });

      if (!result) {
        return notFound(`Conflict not found: ${id}`);
      }

      const resolvedConflict = result as ConflictRecordView;
      const response: WriteResponse<ConflictRecordView> = {
        data: resolvedConflict,
        meta: {
          version: resolvedConflict.version,
          requestId: body.requestId,
        },
      };
      return NextResponse.json(response, { status: 200 });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('VERSION_CONFLICT:')) {
        const currentVersion = Number(err.message.split(':')[1] || body.expectedVersion);
        return versionConflict(currentVersion, body.expectedVersion, body.requestId);
      }
      throw err;
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
