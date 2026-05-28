import { NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import { getRepository } from '@/lib/kivo-engine';
import { buildUtilizationFromEntries } from '@/lib/domain-stores';
import type { UtilizationAnalyticsData } from '@/lib/domain-stores';
import type { ApiResponse } from '@/types';

export async function GET() {
  try {
    const repo = await getRepository();
    const entries = await repo.findAll();

    const response: ApiResponse<UtilizationAnalyticsData> = {
      data: buildUtilizationFromEntries(entries),
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
