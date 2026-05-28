import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import { getWikiRepository } from '@/lib/wiki-engine';
import { ensureWikiAnnotationsTable, listWikiAnnotations } from '@/lib/wiki-annotations';
import { triggerWikiMaterialReextract } from '@/lib/wiki-page-editing';

export const runtime = 'nodejs';

function buildPagePayload(id: string) {
  const repo = getWikiRepository();
  const page = repo.findById(id);
  if (!page || page.type !== 'wiki_page') return null;

  return {
    id: page.id,
    title: page.title,
    content: page.content,
    summary: page.summary,
    status: page.status,
    version: page.version,
    tags: page.tags,
    metadata: page.metadata,
    parentId: page.parentId,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    annotations: listWikiAnnotations(page.id),
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    ensureWikiAnnotationsTable();
    const { id } = await params;
    const payload = buildPagePayload(id);
    if (!payload) return notFound('Wiki 材料不存在');
    return NextResponse.json({ data: payload });
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Unknown error');
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    ensureWikiAnnotationsTable();
    const { id } = await params;
    const repo = getWikiRepository();
    const current = repo.findById(id);
    if (!current || current.type !== 'wiki_page') return notFound('Wiki 材料不存在');

    const body = await request.json() as {
      title?: string;
      summary?: string;
      content?: string;
    };
    const nextTitle = body.title?.trim();
    const nextSummary = body.summary?.trim();
    const nextContent = body.content?.trim();

    if (body.title !== undefined && !nextTitle) return badRequest('title 不能为空');
    if (body.content !== undefined && !nextContent) return badRequest('content 不能为空');

    repo.updatePage(id, {
      title: nextTitle ?? current.title,
      summary: nextSummary ?? current.summary,
      content: nextContent ?? current.content,
      metadata: current.metadata,
      tags: current.tags,
    });

    const reextract = nextContent
      ? triggerWikiMaterialReextract(id, nextContent)
      : { materialId: null, triggered: false };

    const payload = buildPagePayload(id);
    if (!payload) return notFound('Wiki 材料不存在');

    return NextResponse.json({
      data: payload,
      meta: {
        reextractTriggered: reextract.triggered,
        materialId: reextract.materialId,
      },
    });
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Unknown error');
  }
}
