import { NextRequest, NextResponse } from 'next/server';
import { badRequest, serverError } from '@/lib/errors';
import { aggregateWikiPage } from '@/lib/wiki-pages';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined;
    const space = typeof body?.space === 'string' ? body.space.trim() : undefined;

    if (!slug && !title) {
      return badRequest('slug or title is required');
    }

    const result = aggregateWikiPage({
      slug: slug || title || 'wiki-page',
      title,
      space,
    });

    return NextResponse.json({
      data: {
        id: result.page.id,
        slug: result.slug,
        title: result.page.title,
        version: result.page.version,
        sourceCount: result.sources.length,
      },
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
