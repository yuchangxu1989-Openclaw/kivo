import { NextRequest, NextResponse } from 'next/server';
import { notFound, serverError } from '@/lib/errors';
import { adoptResearchTask, confirmResearchReportReference } from '@/lib/research-db';
import type { ResearchDashboardData } from '@/lib/research-db';
import type { ApiResponse } from '@/types';

function taskIdFromReportId(reportId: string): string {
  return reportId.endsWith('-report') ? reportId.slice(0, -'-report'.length) : reportId;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reportId: string }> },
) {
  try {
    const { reportId } = await params;
    const body = await request.json().catch(() => ({}));
    const confirmedBy = typeof body?.confirmedBy === 'string' ? body.confirmedBy : 'web-user';
    const referenceResult = await confirmResearchReportReference({ reportId, confirmedBy });
    if (referenceResult) return NextResponse.json({ data: referenceResult });

    const result = await adoptResearchTask(taskIdFromReportId(reportId));
    if (!result) return notFound(`Research report not found or not completed: ${reportId}`);

    const response: ApiResponse<ResearchDashboardData> = { data: result };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
