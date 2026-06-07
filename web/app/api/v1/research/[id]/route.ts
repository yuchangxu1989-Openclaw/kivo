import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import { updateResearchHighlight } from '@/lib/research-db';
import type { ResearchDashboardData } from '@/lib/research-db';
import { getResearchTaskDetail } from '@/lib/research-db';
import type { ApiResponse } from '@/types';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = getResearchTaskDetail(id);
    if (!result) return notFound(`Research task not found: ${id}`);
    return NextResponse.json({ data: result });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (typeof body?.highlighted !== 'boolean') {
      return badRequest('highlighted (boolean) is required');
    }

    const result = updateResearchHighlight(id, body.highlighted);
    if (!result) return notFound(`Research task not found: ${id}`);

    const response: ApiResponse<ResearchDashboardData> = { data: result };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
