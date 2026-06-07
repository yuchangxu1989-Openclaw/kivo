import { NextRequest, NextResponse } from 'next/server';
import { notFound, serverError } from '@/lib/errors';
import { adoptResearchTask } from '@/lib/research-db';
import type { ResearchDashboardData } from '@/lib/research-db';
import type { ApiResponse } from '@/types';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await adoptResearchTask(id);
    if (!result) return notFound(`Research task not found or not completed: ${id}`);

    const response: ApiResponse<ResearchDashboardData> = { data: result };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
