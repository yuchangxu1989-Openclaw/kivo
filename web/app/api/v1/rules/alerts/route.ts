import { NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import { getKivo } from '@/lib/kivo-engine';
import type { ApiResponse } from '@/types';
import type { DistributionAlert } from '@self-evolving-harness/kivo';

export async function GET() {
  try {
    const kivo = await getKivo();
    const response: ApiResponse<DistributionAlert[]> = {
      data: kivo.getUnhandledDistributionAlerts(),
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
