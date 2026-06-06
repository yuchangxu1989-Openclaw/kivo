import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import { updateResearchHighlight } from '@/lib/domain-stores';
import type { ResearchDashboardData } from '@/lib/domain-stores';
import type { ApiResponse } from '@/types';

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
