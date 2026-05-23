/**
 * PATCH /api/wiki/spaces/[id]/directories/[nodeId]/move — move a node to a new parent
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWikiRepository } from '@/lib/wiki-engine';
import { badRequest, notFound, serverError } from '@/lib/errors';

type WikiRepo = ReturnType<typeof getWikiRepository>;

function directoryDepth(repo: WikiRepo, spaceId: string, directoryId: string): number | null {
  let depth = 0;
  let currentId: string | null = directoryId;
  while (currentId && currentId !== spaceId) {
    const node = repo.findById(currentId);
    if (!node || node.type !== 'wiki_directory') return null;
    depth += 1;
    currentId = node.parentId;
  }
  return currentId === spaceId ? depth : null;
}

function subtreeDirectoryDepth(repo: WikiRepo, nodeId: string): number {
  const node = repo.findById(nodeId);
  if (!node || node.type !== 'wiki_directory') return 0;
  const childDepths = repo
    .listChildren(nodeId)
    .filter((child) => child.type === 'wiki_directory')
    .map((child) => subtreeDirectoryDepth(repo, child.id));
  return 1 + Math.max(0, ...childDepths);
}

function isDescendant(repo: WikiRepo, nodeId: string, candidateParentId: string): boolean {
  if (nodeId === candidateParentId) return true;
  return repo
    .listChildren(nodeId)
    .some((child) => child.id === candidateParentId || (child.type === 'wiki_directory' && isDescendant(repo, child.id, candidateParentId)));
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
    if (!node) {
      return notFound(`Node ${nodeId} not found`);
    }
    if (repo.getSpaceIdForNode(nodeId) !== id) {
      return badRequest('Node does not belong to this space');
    }

    const body = await request.json();
    const { newParentId, sortOrder } = body as { newParentId?: string; sortOrder?: number };

    if (!newParentId) {
      return badRequest('newParentId is required');
    }

    const targetParent = repo.findById(newParentId);
    if (!targetParent || (targetParent.type !== 'wiki_space' && targetParent.type !== 'wiki_directory')) {
      return badRequest('newParentId must be a space or directory');
    }
    if (newParentId !== id && repo.getSpaceIdForNode(newParentId) !== id) {
      return badRequest('newParentId must belong to this space');
    }
    if (node.type === 'wiki_directory' && isDescendant(repo, nodeId, newParentId)) {
      return badRequest('Cannot move a directory into itself or its descendants');
    }

    if (node.type === 'wiki_directory') {
      const parentDepth = newParentId === id ? 0 : directoryDepth(repo, id, newParentId);
      if (parentDepth === null) return badRequest('newParentId must belong to this space');
      if (parentDepth + subtreeDirectoryDepth(repo, nodeId) > 3) {
        return badRequest('Maximum nesting depth (3 levels) exceeded');
      }
    }

    const updated = repo.moveNode(nodeId, newParentId, sortOrder);

    return NextResponse.json({
      data: { id: updated.id, parentId: updated.parentId, sortOrder: updated.sortOrder },
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
