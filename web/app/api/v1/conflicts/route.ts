import { NextRequest, NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import { getConflictData } from '@/lib/domain-stores';
import type { ConflictRecordView } from '@/lib/domain-stores';
import type { ApiResponse } from '@/types';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || 'pending';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));

    const allConflicts = getConflictData().items;
    const filtered = status === 'resolved'
      ? allConflicts.filter((item) => item.status === 'resolved')
      : status === 'all'
        ? allConflicts
        : allConflicts.filter((item) => item.status === 'unresolved');

    const total = filtered.length;
    const offset = (page - 1) * pageSize;
    const items = filtered.slice(offset, offset + pageSize);

    const response: ApiResponse<ConflictRecordView[]> = {
      data: items,
      meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
