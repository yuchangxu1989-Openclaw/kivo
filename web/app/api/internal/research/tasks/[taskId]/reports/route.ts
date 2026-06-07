import { NextRequest, NextResponse } from 'next/server';
import { badRequest, errorResponse, serverError } from '@/lib/errors';
import { registerResearchReport } from '@/lib/research-db';

function isAuthorized(request: NextRequest): boolean {
  const token = process.env.KIVO_INTERNAL_TOKEN;
  if (!token) return false;
  const authorization = request.headers.get('authorization') ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  return bearer === token || request.headers.get('x-internal-token') === token || request.headers.get('x-kivo-internal-token') === token;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    if (!isAuthorized(request)) return errorResponse('UNAUTHORIZED', 'Invalid internal token', 401);
    const { taskId } = await params;
    const body = await request.json();
    const reportUri = typeof body?.reportUri === 'string' ? body.reportUri.trim() : '';
    if (!reportUri) return badRequest('reportUri is required');

    const result = registerResearchReport({
      taskId,
      reportUri,
      title: typeof body?.title === 'string' ? body.title : undefined,
      reportKind: typeof body?.reportKind === 'string' ? body.reportKind : undefined,
      externalContentHash: typeof body?.contentHash === 'string' ? body.contentHash : undefined,
      metadata: body?.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
    });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
