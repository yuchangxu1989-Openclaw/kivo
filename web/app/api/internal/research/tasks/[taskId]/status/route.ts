import { NextRequest, NextResponse } from 'next/server';
import { badRequest, errorResponse, serverError } from '@/lib/errors';
import { updateRegisteredResearchTaskStatus } from '@/lib/research-db';

const STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);

function isAuthorized(request: NextRequest): boolean {
  const token = process.env.KIVO_INTERNAL_TOKEN;
  if (!token) return false;
  const authorization = request.headers.get('authorization') ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  return bearer === token || request.headers.get('x-internal-token') === token || request.headers.get('x-kivo-internal-token') === token;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    if (!isAuthorized(request)) return errorResponse('UNAUTHORIZED', 'Invalid internal token', 401);
    const { taskId } = await params;
    const body = await request.json();
    const status = typeof body?.status === 'string' ? body.status : '';
    if (!STATUSES.has(status)) return badRequest('status must be running, completed, failed, or cancelled');

    const reason = typeof body?.failureReason === 'string'
      ? body.failureReason
      : (typeof body?.reason === 'string' ? body.reason : undefined);
    if ((status === 'failed' || status === 'cancelled') && !reason?.trim()) {
      return badRequest('failureReason is required for failed or cancelled status');
    }

    const result = updateRegisteredResearchTaskStatus({
      taskId,
      status: status as 'running' | 'completed' | 'failed' | 'cancelled',
      reason,
      reportUri: typeof body?.reportUri === 'string' ? body.reportUri : undefined,
      reportTitle: typeof body?.reportTitle === 'string' ? body.reportTitle : undefined,
      executorId: typeof body?.executorId === 'string' ? body.executorId : undefined,
    });
    return NextResponse.json({ data: result });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
