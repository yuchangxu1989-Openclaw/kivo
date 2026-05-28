/**
 * PATCH /api/v1/knowledge/:id/review
 * Review a pending_review entry: approve, reject, or edit+approve
 */

import { NextRequest, NextResponse } from 'next/server';
import { getKivo, getRepository } from '@/lib/kivo-engine';
import { badRequest, notFound, serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';
import type { KnowledgeEntry } from '@self-evolving-harness/kivo';

type ReviewAction = 'approve' | 'reject' | 'edit';

interface ReviewRequest {
  action: ReviewAction;
  content?: string;
  title?: string;
  summary?: string;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const body = (await request.json()) as ReviewRequest;

    if (!body.action || !['approve', 'reject', 'edit'].includes(body.action)) {
      return badRequest('action is required and must be one of: approve, reject, edit');
    }

    if (body.action === 'edit' && !body.content) {
      return badRequest('content is required when action is "edit"');
    }

    await getKivo();
    const repo = await getRepository();
    const entry = await repo.findById(id);

    if (!entry) {
      return notFound(`Knowledge entry not found: ${id}`);
    }

    if ((entry.status as string) !== 'pending_review') {
      return badRequest(`Entry is not pending review (current status: ${entry.status})`);
    }

    const now = new Date();

    if (body.action === 'approve') {
      // Approve: set status to active
      entry.status = 'active';
      entry.updatedAt = now;
    } else if (body.action === 'reject') {
      // Reject: set status to rejected
      (entry as any).status = 'rejected';
      entry.updatedAt = now;
    } else if (body.action === 'edit') {
      // Edit + approve: update content and set status to active
      entry.content = body.content!;
      if (body.title) entry.title = body.title;
      if (body.summary) entry.summary = body.summary;
      entry.status = 'active';
      entry.updatedAt = now;
    }

    // Use updateStatus for status change, then save for content edits
    if (body.action === 'edit') {
      // For edit, we need to save the full entry with updated content
      await repo.save(entry, { skipQualityGate: true, skipEmbedding: false } as any);
    } else {
      await repo.updateStatus(id, entry.status as any);
    }

    const response: ApiResponse<KnowledgeEntry> = {
      data: entry,
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
