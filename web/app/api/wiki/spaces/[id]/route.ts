/**
 * PATCH /api/wiki/spaces/[id] — update space (rename, description, icon)
 * DELETE /api/wiki/spaces/[id] — soft-delete space
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWikiRepository } from '@/lib/wiki-engine';
import { ensureMaterialSpaceExists } from '@/lib/wiki-materials';
import { badRequest, notFound, serverError } from '@/lib/errors';

/**
 * Resolve the `default` literal alias (and missing IDs) to the real default-space UUID,
 * keeping PATCH/DELETE handlers in sync with the entries route alias semantics.
 */
function resolveSpaceIdOrNull(rawId: string): string | null {
  try {
    return ensureMaterialSpaceExists(rawId);
  } catch {
    return null;
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: rawId } = await params;
    const repo = getWikiRepository();
    const id = resolveSpaceIdOrNull(rawId);
    if (!id) return notFound(`Space ${rawId} not found`);

    const existing = repo.findById(id);
    if (!existing || existing.type !== 'wiki_space') {
      return notFound(`Space ${rawId} not found`);
    }

    const body = await request.json();
    const { title, description, icon } = body as { title?: string; description?: string; icon?: string };

    if (title !== undefined && title.trim().length === 0) {
      return badRequest('title cannot be empty');
    }
    if (title !== undefined) {
      const duplicate = repo.listSpaces().find((space) => space.id !== id && space.title.trim().toLowerCase() === title.trim().toLowerCase());
      if (duplicate) {
        return badRequest('space title must be unique');
      }
    }

    const metadata = icon !== undefined
      ? { ...existing.metadata, extra: { ...(existing.metadata.extra ?? {}), icon } }
      : existing.metadata;

    const updated = repo.updateSpace(id, {
      title: title?.trim(),
      content: description?.trim(),
      summary: description?.trim().slice(0, 100),
      metadata,
    });

    return NextResponse.json({
      data: { id: updated.id, title: updated.title },
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: rawId } = await params;
    const repo = getWikiRepository();
    const id = resolveSpaceIdOrNull(rawId);
    if (!id) return notFound(`Space ${rawId} not found`);

    const existing = repo.findById(id);
    if (!existing || existing.type !== 'wiki_space') {
      return notFound(`Space ${rawId} not found`);
    }

    repo.softDeleteNode(id);

    return NextResponse.json({ data: { id, deleted: true } });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
