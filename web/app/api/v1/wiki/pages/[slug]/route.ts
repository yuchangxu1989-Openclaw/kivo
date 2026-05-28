import { NextRequest, NextResponse } from 'next/server';
import { notFound, serverError } from '@/lib/errors';
import { getWikiPageDetailBySlug } from '@/lib/wiki-pages';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const space = new URL(request.url).searchParams.get('space');
    const detail = getWikiPageDetailBySlug(slug, space);
    if (!detail) return notFound(`Wiki page not found: ${slug}`);

    return NextResponse.json({
      data: {
        id: detail.page.id,
        slug: detail.slug,
        title: detail.page.title,
        content: detail.page.content,
        summary: detail.page.summary,
        status: detail.page.status,
        version: detail.page.version,
        metadata: detail.page.metadata,
        sourcePages: detail.sourcePages.map((page) => ({
          id: page.id,
          title: page.title,
          summary: page.summary,
        })),
        versions: detail.versions,
        links: detail.outgoingLinks,
        backlinks: detail.backlinks,
      },
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
