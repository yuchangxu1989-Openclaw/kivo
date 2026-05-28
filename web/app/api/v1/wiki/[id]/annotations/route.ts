import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import { getWikiRepository } from '@/lib/wiki-engine';
import { createWikiAnnotation, ensureWikiAnnotationsTable, listWikiAnnotations } from '@/lib/wiki-annotations';

export const runtime = 'nodejs';

function wikiPageExists(id: string) {
  const page = getWikiRepository().findById(id);
  return page?.type === 'wiki_page';
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    ensureWikiAnnotationsTable();
    const { id } = await params;
    if (!wikiPageExists(id)) return notFound('Wiki 材料不存在');
    return NextResponse.json({ data: listWikiAnnotations(id) });
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Unknown error');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    ensureWikiAnnotationsTable();
    const { id } = await params;
    if (!wikiPageExists(id)) return notFound('Wiki 材料不存在');

    let body: { content?: string; position?: number };
    try {
      body = await request.json() as { content?: string; position?: number };
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const content = body.content?.trim();
    if (!content) return badRequest('content 不能为空');

    const annotation = createWikiAnnotation({
      wikiPageId: id,
      content,
      position: typeof body.position === 'number' ? body.position : null,
    });
    return NextResponse.json({ data: annotation }, { status: 201 });
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Unknown error');
  }
}
