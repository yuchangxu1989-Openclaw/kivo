import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import { getWikiRepository } from '@/lib/wiki-engine';
import { deleteWikiAnnotation, ensureWikiAnnotationsTable, updateWikiAnnotation } from '@/lib/wiki-annotations';

export const runtime = 'nodejs';

function wikiPageExists(id: string) {
  const page = getWikiRepository().findById(id);
  return page?.type === 'wiki_page';
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; annotationId: string }> },
) {
  try {
    ensureWikiAnnotationsTable();
    const { id, annotationId } = await params;
    if (!wikiPageExists(id)) return notFound('Wiki 材料不存在');

    let body: { content?: string; position?: number };
    try {
      body = await request.json() as { content?: string; position?: number };
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const content = body.content?.trim();
    if (!content) return badRequest('content 不能为空');

    const annotation = updateWikiAnnotation({
      id: annotationId,
      wikiPageId: id,
      content,
      position: typeof body.position === 'number' ? body.position : null,
    });
    if (!annotation) return notFound('批注不存在');

    return NextResponse.json({ data: annotation });
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Unknown error');
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; annotationId: string }> },
) {
  try {
    ensureWikiAnnotationsTable();
    const { id, annotationId } = await params;
    if (!wikiPageExists(id)) return notFound('Wiki 材料不存在');
    if (!deleteWikiAnnotation(id, annotationId)) return notFound('批注不存在');
    return NextResponse.json({ success: true });
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Unknown error');
  }
}
