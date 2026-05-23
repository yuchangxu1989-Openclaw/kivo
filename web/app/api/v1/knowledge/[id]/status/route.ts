/**
 * DELETE /api/v1/knowledge/:id/status
 * Physically delete a knowledge entry (FR-J02)
 * Implements expectedVersion + requestId + 409 VERSION_CONFLICT protocol
 */

import { NextRequest, NextResponse } from 'next/server';
import { getKivo, getRepository } from '@/lib/kivo-engine';
import { appendKnowledgeSnapshot, ensureKnowledgeHistory } from '@/lib/knowledge-history';
import { badRequest, notFound, versionConflict, serverError } from '@/lib/errors';
import type { WriteRequestFields } from '@/types';

interface DeleteRequest extends WriteRequestFields {
  expectedVersion: number;
  requestId: string;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const body = (await request.json()) as DeleteRequest;

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

    if (entry.version !== body.expectedVersion) {
      return versionConflict(entry.version, body.expectedVersion, body.requestId);
    }

    ensureKnowledgeHistory(entry);
    appendKnowledgeSnapshot(entry, `条目已被物理删除。`);

    const repo = await getRepository();
    await repo.delete(id);

    return NextResponse.json({ success: true, meta: { requestId: body.requestId } });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
