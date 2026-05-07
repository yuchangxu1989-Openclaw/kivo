import { NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import { getDispatchAnalyticsData } from '@/lib/domain-stores';
import type { DispatchAnalyticsData } from '@/lib/domain-stores';
import type { ApiResponse } from '@/types';

export async function GET() {
  try {
    const response: ApiResponse<DispatchAnalyticsData> = {
      data: getDispatchAnalyticsData(),
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
