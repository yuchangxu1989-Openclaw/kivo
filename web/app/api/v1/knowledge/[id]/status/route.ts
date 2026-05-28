/**
 * DELETE /api/v1/knowledge/:id/status
 * Physically delete a knowledge entry (FR-J02)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getKivo, getRepository } from '@/lib/kivo-engine';
import { appendKnowledgeSnapshot, ensureKnowledgeHistory } from '@/lib/knowledge-history';
import { notFound, serverError } from '@/lib/errors';

interface DeleteRequest {
  requestId?: string;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const rawBody = await request.text();
    const body = rawBody ? JSON.parse(rawBody) as DeleteRequest : {};
    const requestId = typeof body.requestId === 'string' && body.requestId.trim()
      ? body.requestId
      : crypto.randomUUID();

    const kivo = await getKivo();
    const entry = await kivo.getEntry(id);

    if (!entry) {
      return notFound(`Knowledge entry not found: ${id}`);
    }

    ensureKnowledgeHistory(entry);
    appendKnowledgeSnapshot(entry, `条目已被物理删除。`);

    const repo = await getRepository();
    await repo.delete(id);

    return NextResponse.json({ success: true, meta: { requestId } });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
