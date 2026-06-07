import { NextRequest, NextResponse } from 'next/server';
import { badRequest, errorResponse, serverError } from '@/lib/errors';
import { registerResearchTask } from '@/lib/research-db';

function isAuthorized(request: NextRequest): boolean {
  const token = process.env.KIVO_INTERNAL_TOKEN;
  if (!token) return false;
  const authorization = request.headers.get('authorization') ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  return bearer === token || request.headers.get('x-internal-token') === token || request.headers.get('x-kivo-internal-token') === token;
}

export async function POST(request: NextRequest) {
  try {
    if (!isAuthorized(request)) return errorResponse('UNAUTHORIZED', 'Invalid internal token', 401);
    const body = await request.json();
    const topicName = typeof body?.topicName === 'string' ? body.topicName.trim() : '';
    const taskTitle = typeof body?.taskTitle === 'string' ? body.taskTitle.trim() : '';
    if (!topicName || !taskTitle) return badRequest('topicName and taskTitle are required');

    const result = await registerResearchTask({
      topicName,
      taskTitle,
      query: typeof body?.query === 'string' ? body.query : undefined,
      sourceType: typeof body?.sourceType === 'string' ? body.sourceType : undefined,
      sourceRef: typeof body?.sourceRef === 'string' ? body.sourceRef : undefined,
      actorId: typeof body?.actorId === 'string' ? body.actorId : undefined,
      executorId: typeof body?.executorId === 'string' ? body.executorId : undefined,
      metadata: body?.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
    });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
