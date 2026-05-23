/**
 * PATCH /api/wiki/spaces/[id]/directories/[nodeId] — rename a directory
 * DELETE /api/wiki/spaces/[id]/directories/[nodeId] — soft-delete a directory (cascade)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWikiRepository } from '@/lib/wiki-engine';
import { badRequest, notFound, serverError } from '@/lib/errors';

function collectDescendantIds(repo: ReturnType<typeof getWikiRepository>, nodeId: string): string[] {
  const ids: string[] = [];
  for (const child of repo.listChildren(nodeId)) {
    ids.push(child.id);
    if (child.type === 'wiki_directory') ids.push(...collectDescendantIds(repo, child.id));
  }
  return ids;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  try {
    const { id, nodeId } = await params;
    const repo = getWikiRepository();

    const space = repo.findById(id);
    if (!space || space.type !== 'wiki_space') {
      return notFound(`Space ${id} not found`);
    }

    const node = repo.findById(nodeId);
    if (!node || node.type !== 'wiki_directory') {
      return notFound(`Directory ${nodeId} not found`);
    }
    if (repo.getSpaceIdForNode(nodeId) !== id) {
      return badRequest('Directory does not belong to this space');
    }

    const body = await request.json();
    const { title } = body as { title?: string };

    if (!title || title.trim().length === 0) {
      return badRequest('title is required');
    }

    const ts = new Date().toISOString();
    repo.db.prepare(`
      UPDATE entries SET title = ?, updated_at = ? WHERE id = ? AND type = 'wiki_directory'
    `).run(title.trim(), ts, nodeId);

    return NextResponse.json({ data: { id: nodeId, title: title.trim() } });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  try {
    const { id, nodeId } = await params;
    const repo = getWikiRepository();

    const space = repo.findById(id);
    if (!space || space.type !== 'wiki_space') {
      return notFound(`Space ${id} not found`);
    }

    const node = repo.findById(nodeId);
    if (!node || node.type !== 'wiki_directory') {
      return notFound(`Directory ${nodeId} not found`);
    }
    if (repo.getSpaceIdForNode(nodeId) !== id) {
      return badRequest('Directory does not belong to this space');
    }

    const descendantIds = collectDescendantIds(repo, nodeId);
    for (const descendantId of descendantIds.reverse()) {
      repo.softDeleteNode(descendantId);
    }
    repo.softDeleteNode(nodeId);

    return NextResponse.json({ data: { id: nodeId, deleted: true } });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
