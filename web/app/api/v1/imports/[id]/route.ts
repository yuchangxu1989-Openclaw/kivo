import { NextRequest, NextResponse } from 'next/server';
import { notFound, serverError } from '@/lib/errors';
import { getImportStore } from '@/lib/import-store';
import type { ApiResponse } from '@/types';
import type { ImportJob } from '../route';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const job = getImportStore().get(params.id);
    if (!job) {
      return notFound(`Import job not found: ${params.id}`);
    }

    return NextResponse.json({ data: job } satisfies ApiResponse<ImportJob>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
