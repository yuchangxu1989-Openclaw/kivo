/**
 * GET /api/wiki/pages/[id]
 * PATCH /api/wiki/pages/[id]
 * DELETE /api/wiki/pages/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWikiRepository } from '@/lib/wiki-engine';
import { badRequest, notFound, serverError } from '@/lib/errors';

function pagePayload(repo: ReturnType<typeof getWikiRepository>, id: string) {
  const page = repo.findById(id);
  if (!page || page.type !== 'wiki_page') return null;
  return {
    id: page.id,
    type: page.metadata?.extra?.knowledgeType || 'fact',
    title: page.title,
    content: page.content,
    summary: page.summary,
    tags: page.tags,
    status: page.status,
    parentId: page.parentId,
    version: page.version,
    metadata: page.metadata,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const repo = getWikiRepository();
    const data = pagePayload(repo, id);
    if (!data) return notFound(`Page ${id} not found`);
    return NextResponse.json({ data });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const repo = getWikiRepository();
    const page = repo.findById(id);
    if (!page || page.type !== 'wiki_page') return notFound(`Page ${id} not found`);

    const body = await request.json();
    const { title, content, summary, type, tags, parentId } = body as {
      title?: string;
      content?: string;
      summary?: string;
      type?: string;
      tags?: string[];
      parentId?: string;
    };

    if (title !== undefined && !title.trim()) return badRequest('title cannot be empty');
    if (content !== undefined && !content.trim()) return badRequest('content cannot be empty');
    repo.updatePage(id, {
      title: title?.trim(),
      content: content?.trim(),
      summary: summary?.trim(),
      parentId,
      tags: Array.isArray(tags) ? tags : undefined,
      metadata: {
        ...page.metadata,
        extra: {
          ...(page.metadata.extra ?? {}),
          knowledgeType: type || page.metadata?.extra?.knowledgeType || 'fact',
          graphNodeHref: `/graph?focus=${id}`,
        },
      },
    });

    return NextResponse.json({ data: pagePayload(repo, id) });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const repo = getWikiRepository();
    const page = repo.findById(id);
    if (!page || page.type !== 'wiki_page') return notFound(`Page ${id} not found`);
    repo.softDeleteNode(id);
    return NextResponse.json({ data: { id, deleted: true } });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
