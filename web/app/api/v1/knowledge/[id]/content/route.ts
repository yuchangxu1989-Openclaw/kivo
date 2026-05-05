/**
 * PUT /api/v1/knowledge/:id/content
 * Edit knowledge entry summary/content (FR-J02 AC3)
 * Implements expectedVersion + requestId + 409 VERSION_CONFLICT protocol
 */

import { NextRequest, NextResponse } from 'next/server';
import { getKivo, persistEntry } from '@/lib/kivo-engine';
import { appendKnowledgeSnapshot, ensureKnowledgeHistory, getKnowledgeHistory } from '@/lib/knowledge-history';
import { badRequest, notFound, versionConflict, serverError } from '@/lib/errors';
import type { ContentEditRequest, WriteResponse } from '@/types';
import type { KnowledgeEntry } from '@self-evolving-harness/kivo';

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const body = (await request.json()) as ContentEditRequest;

    // Validate required fields
    if (!body.content || typeof body.content !== 'string') {
      return badRequest('content is required and must be a string');
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

    ensureKnowledgeHistory(entry);
    const previousHistory = getKnowledgeHistory(entry);
    const previousVersion = previousHistory.find((item) => item.version === entry.version);

    // Persist updated entry
    const updatedEntry: KnowledgeEntry = {
      ...entry,
      content: body.content,
      summary: body.summary || entry.summary,
      updatedAt: new Date(),
      version: entry.version + 1,
    };

    const saved = await persistEntry(updatedEntry);
    if (!saved) {
      return badRequest('质量门禁拒绝保存该内容，请检查是否重复或低价值。');
    }
    appendKnowledgeSnapshot(updatedEntry, previousVersion ? `对比 v${previousVersion.version}：摘要正文已更新。` : '摘要正文已更新。');

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
