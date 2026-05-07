import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import {
  createResearchTask,
  deleteResearchTask,
  getResearchDashboardData,
  setResearchAutoPaused,
  updateResearchTaskPriority,
} from '@/lib/domain-stores';
import type { Priority, ResearchDashboardData } from '@/lib/domain-stores';
import type { ApiResponse } from '@/types';

const PRIORITIES: Priority[] = ['高', '中', '低'];
const DEFAULT_EXPECTED_TYPES = ['fact', 'decision', 'methodology'];

function inferBudgetCredits(priority: Priority) {
  if (priority === '高') return 36;
  if (priority === '中') return 20;
  return 12;
}

export async function GET() {
  try {
    const response: ApiResponse<ResearchDashboardData> = {
      data: getResearchDashboardData(),
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const topic = typeof body?.topic === 'string' ? body.topic.trim() : '';
    const scope = typeof body?.scope === 'string' ? body.scope.trim() : '';
    const priority = body?.priority as Priority | undefined;

    if (!topic || !scope || !priority || !PRIORITIES.includes(priority)) {
      return badRequest('topic, scope, priority are required');
    }

    const response: ApiResponse<ResearchDashboardData> = {
      data: createResearchTask({
        topic, scope, priority,
        budgetCredits: inferBudgetCredits(priority),
        expectedTypes: DEFAULT_EXPECTED_TYPES,
      }),
    };

    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();

    if (typeof body?.autoResearchPaused === 'boolean') {
      const response: ApiResponse<ResearchDashboardData> = {
        data: setResearchAutoPaused(body.autoResearchPaused),
      };
      return NextResponse.json(response);
    }

    const id = typeof body?.id === 'string' ? body.id : '';
    const priority = body?.priority as Priority | undefined;

    if (!id || !priority || !PRIORITIES.includes(priority)) {
      return badRequest('id and valid priority are required');
    }

    const updated = updateResearchTaskPriority(id, priority);
    if (!updated) {
      return notFound(`Research task not found: ${id}`);
    }

    const response: ApiResponse<ResearchDashboardData> = { data: updated };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return badRequest('id is required');
    }

    const updated = deleteResearchTask(id);
    if (!updated) {
      return notFound(`Research task not found: ${id}`);
    }

    const response: ApiResponse<ResearchDashboardData> = { data: updated };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
