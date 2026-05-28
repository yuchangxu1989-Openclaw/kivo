import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import { appendActivityEvent } from '@/lib/domain-stores';
import type { ApiResponse } from '@/types';
import {
  loadResearchTasksFromDb,
  deleteResearchTaskFromDb,
  updateResearchTaskPriorityInDb,
  persistResearchTask,
} from '@/lib/research-db';

const PRIORITIES = ['高', '中', '低'] as const;
type Priority = typeof PRIORITIES[number];
const DEFAULT_EXPECTED_TYPES = ['fact', 'decision', 'methodology'];

function inferBudgetCredits(priority: Priority) {
  if (priority === '高') return 36;
  if (priority === '中') return 20;
  return 12;
}

export async function GET() {
  try {
    const data = loadResearchTasksFromDb();
    const response: ApiResponse<typeof data> = { data };
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

    persistResearchTask({
      topic, scope, priority,
      budgetCredits: inferBudgetCredits(priority),
      expectedTypes: DEFAULT_EXPECTED_TYPES,
    });

    appendActivityEvent({
      type: 'research_created', label: '新调研任务',
      summary: `已创建调研任务「${topic}」,进入队列等待执行。`,
      href: '/research', tags: ['research', 'queued'],
    });

    const data = loadResearchTasksFromDb();
    return NextResponse.json({ data } satisfies ApiResponse<typeof data>, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();

    if (typeof body?.autoResearchPaused === 'boolean') {
      appendActivityEvent({
        type: body.autoResearchPaused ? 'research_paused' : 'research_resumed',
        label: body.autoResearchPaused ? '自动调研暂停' : '自动调研恢复',
        summary: body.autoResearchPaused ? '调研队列已进入静默模式。' : '调研队列已恢复自动处理。',
        href: '/research', tags: ['research', body.autoResearchPaused ? 'paused' : 'resumed'],
      });
      const data = loadResearchTasksFromDb();
      return NextResponse.json({ data } satisfies ApiResponse<typeof data>);
    }

    const id = typeof body?.id === 'string' ? body.id : '';
    const priority = body?.priority as Priority | undefined;

    if (!id || !priority || !PRIORITIES.includes(priority)) {
      return badRequest('id and valid priority are required');
    }

    const updated = updateResearchTaskPriorityInDb(id, priority);
    if (!updated) {
      return notFound(`Research task not found: ${id}`);
    }

    appendActivityEvent({
      type: 'research_updated', label: '调研优先级调整',
      summary: `调研任务优先级已调整为「${priority}」。`,
      href: '/research', tags: ['research', 'priority'],
    });

    const data = loadResearchTasksFromDb();
    return NextResponse.json({ data } satisfies ApiResponse<typeof data>);
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

    const deleted = deleteResearchTaskFromDb(id);
    if (!deleted) {
      return notFound(`Research task not found: ${id}`);
    }

    appendActivityEvent({
      type: 'research_cancelled', label: '调研取消',
      summary: '调研任务已从队列中移除。',
      href: '/research', tags: ['research', 'cancelled'],
    });

    const data = loadResearchTasksFromDb();
    return NextResponse.json({ data } satisfies ApiResponse<typeof data>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
