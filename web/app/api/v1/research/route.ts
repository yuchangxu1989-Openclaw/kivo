import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import {
  createResearchTask as createResearchTaskDb,
  deleteResearchTask as deleteResearchTaskDb,
  getResearchDashboardData as getResearchDashboardDataDb,
  setResearchAutoPaused as setResearchAutoPausedDb,
  updateResearchTaskPriority as updateResearchTaskPriorityDb,
} from '@/lib/research-db';
import type { Priority, ResearchDashboardData } from '@/lib/research-db';
import type { ApiResponse } from '@/types';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];
const DEFAULT_EXPECTED_TYPES = ['fact', 'decision', 'methodology'];

function inferBudgetCredits(priority: Priority) {
  if (priority === 'urgent') return 48;
  if (priority === 'high') return 36;
  if (priority === 'medium') return 20;
  return 12;
}

function parsePriority(value: unknown): Priority {
  if (value === '高') return 'high';
  if (value === '中') return 'medium';
  if (value === '低') return 'low';
  return PRIORITIES.includes(value as Priority) ? value as Priority : 'medium';
}

export async function GET() {
  try {
    const response: ApiResponse<ResearchDashboardData> = {
      data: getResearchDashboardDataDb(),
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    const topic = typeof body?.topic === 'string' ? body.topic.trim() : query;
    const scope = typeof body?.scope === 'string' ? body.scope.trim() : topic;
    const priority = parsePriority(body?.priority);

    if (!topic || !scope || !PRIORITIES.includes(priority)) {
      return badRequest('topic or query, scope, and valid priority are required');
    }

    const response: ApiResponse<ResearchDashboardData> = {
      data: await createResearchTaskDb({
        topic, query, scope, priority,
        budgetCredits: inferBudgetCredits(priority),
        expectedTypes: DEFAULT_EXPECTED_TYPES,
        requestedBy: typeof body?.requestedBy === 'string' ? body.requestedBy : undefined,
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
        data: setResearchAutoPausedDb(body.autoResearchPaused),
      };
      return NextResponse.json(response);
    }

    const id = typeof body?.id === 'string' ? body.id : '';
    const priority = parsePriority(body?.priority);

    if (!id || !PRIORITIES.includes(priority)) {
      return badRequest('id and valid priority are required');
    }

    const updated = updateResearchTaskPriorityDb(id, priority);
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

    const updated = deleteResearchTaskDb(id);
    if (!updated) {
      return notFound(`Research task not found: ${id}`);
    }

    const response: ApiResponse<ResearchDashboardData> = { data: updated };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
