import { NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import { getDispatchAnalyticsData } from '@/lib/domain-stores';
import { getKivo } from '@/lib/kivo-engine';
import type { DispatchAnalyticsData } from '@/lib/domain-stores';
import type { ApiResponse } from '@/types';

export async function GET() {
  try {
    const kivo = await getKivo();
    const alerts = kivo.getUnhandledDistributionAlerts().map((alert) => ({
      id: alert.id,
      ruleId: alert.ruleId,
      error: alert.error,
      timestamp: alert.timestamp.toISOString(),
    }));
    const response: ApiResponse<DispatchAnalyticsData> = {
      data: {
        ...getDispatchAnalyticsData(),
        unhandledAlertCount: alerts.length,
        alerts,
      },
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
