import { queryOperationLogs, type OperationEventType } from '@/lib/operation-log-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const event_type = (searchParams.get('type') || 'all') as OperationEventType | 'all';
  const limit = Math.min(Number(searchParams.get('limit') || '50'), 200);
  const offset = Math.max(Number(searchParams.get('offset') || '0'), 0);

  const result = queryOperationLogs({ event_type, limit, offset });

  return Response.json({
    success: true,
    data: result,
  });
}
