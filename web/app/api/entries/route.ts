import { NextRequest, NextResponse } from 'next/server';
import { getKivo } from '@/lib/kivo-engine';
import { findEntriesPaginated } from '@/lib/paginated-queries';
import { serverError } from '@/lib/errors';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '100', 10)));

    await getKivo();
    const result = findEntriesPaginated({
      type: searchParams.get('type') || undefined,
      status: searchParams.get('status') || undefined,
      domain: searchParams.get('domain') || undefined,
      source: searchParams.get('source') || undefined,
      sort: searchParams.get('sort') || 'updatedAt',
      page,
      pageSize,
      includeAll: searchParams.get('includeAll') === 'true',
    });

    return NextResponse.json({
      entries: result.items,
      data: result.items,
      meta: {
        total: result.total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
      },
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
