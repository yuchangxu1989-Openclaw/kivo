/**
 * GET /api/wiki/spaces/[id]/directories — get directory tree for a space
 * POST /api/wiki/spaces/[id]/directories — create a directory in the space
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWikiRepository } from '@/lib/wiki-engine';
import { ensureMaterialSpaceExists } from '@/lib/wiki-materials';
import { badRequest, notFound, serverError } from '@/lib/errors';

function resolveSpaceIdOrNull(rawId: string): string | null {
  try {
    return ensureMaterialSpaceExists(rawId);
  } catch {
    return null;
  }
}

interface TreeNodeResponse {
  id: string;
  title: string;
  type: 'space' | 'directory' | 'page';
  summary: string;
  parentId: string | null;
  children: TreeNodeResponse[];
}

function mapTree(node: { id: string; title: string; type: string; summary: string; parentId: string | null; children: unknown[] }): TreeNodeResponse {
  return {
    id: node.id,
    title: node.title,
    type: node.type === 'wiki_space' ? 'space' : node.type === 'wiki_directory' ? 'directory' : 'page',
    summary: node.summary,
    parentId: node.parentId,
    children: (node.children as typeof node[]).map(mapTree),
  };
}

function directoryDepth(repo: ReturnType<typeof getWikiRepository>, spaceId: string, directoryId: string): number | null {
  let depth = 0;
  let currentId: string | null = directoryId;
  while (currentId && currentId !== spaceId) {
    const node = repo.findById(currentId);
    if (!node) return null;
    if (node.type !== 'wiki_directory') return null;
    depth += 1;
    currentId = node.parentId;
  }
  return currentId === spaceId ? depth : null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: rawId } = await params;
    const repo = getWikiRepository();
    const id = resolveSpaceIdOrNull(rawId);
    if (!id) return notFound(`Space ${rawId} not found`);

    const space = repo.findById(id);
    if (!space || space.type !== 'wiki_space') {
      return notFound(`Space ${rawId} not found`);
    }

    const tree = repo.getSpaceTree(id);
    const response = mapTree(tree as unknown as Parameters<typeof mapTree>[0]);

    return NextResponse.json({ data: response });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: rawId } = await params;
    const repo = getWikiRepository();
    const id = resolveSpaceIdOrNull(rawId);
    if (!id) return notFound(`Space ${rawId} not found`);

    const space = repo.findById(id);
    if (!space || space.type !== 'wiki_space') {
      return notFound(`Space ${rawId} not found`);
    }

    const body = await request.json();
    const { title, parentId } = body as { title?: string; parentId?: string };

    if (!title || title.trim().length === 0) {
      return badRequest('title is required');
    }

    const actualParentId = parentId || id;
    const parent = repo.findById(actualParentId);
    if (!parent || (parent.type !== 'wiki_space' && parent.type !== 'wiki_directory')) {
      return badRequest('parentId must be a space or directory');
    }
    if (actualParentId !== id && repo.getSpaceIdForNode(actualParentId) !== id) {
      return badRequest('parentId must belong to this space');
    }

    if (actualParentId !== id) {
      const depth = directoryDepth(repo, id, actualParentId);
      if (depth === null) return badRequest('parentId must belong to this space');
      if (depth >= 3) return badRequest('Maximum nesting depth (3 levels) exceeded');
    }

    const dir = repo.createDirectory({
      title: title.trim(),
      parentId: actualParentId,
      summary: '',
    });

    return NextResponse.json({ data: { id: dir.id, title: dir.title } }, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
