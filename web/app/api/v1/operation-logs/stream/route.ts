import {
  addOperationLogListener,
  getOperationLogsSinceId,
  getLatestOperationLogId,
  type OperationLogEntry,
} from '@/lib/operation-log-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lastEventId = searchParams.get('lastEventId')
    || request.headers.get('Last-Event-ID')
    || request.headers.get('last-event-id')
    || '';

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      // AC4: Replay missed events on reconnection
      const sinceId = lastEventId ? Number(lastEventId) : 0;
      if (sinceId > 0) {
        const missed = getOperationLogsSinceId(sinceId);
        if (missed.length > 0) {
          const lastId = missed[missed.length - 1].id;
          controller.enqueue(
            encoder.encode(`id: ${lastId}\nevent: replay\ndata: ${JSON.stringify(missed)}\n\n`)
          );
        }
      } else {
        // Send current max ID so client knows where it is
        const currentId = getLatestOperationLogId();
        controller.enqueue(
          encoder.encode(`id: ${currentId}\nevent: init\ndata: ${JSON.stringify({ latestId: currentId })}\n\n`)
        );
      }

      // AC3: Real-time push via listener
      const unsubscribe = addOperationLogListener((entry: OperationLogEntry) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`id: ${entry.id}\nevent: operation\ndata: ${JSON.stringify(entry)}\n\n`)
          );
        } catch {
          // stream closed
        }
      });

      // Heartbeat every 15s to keep connection alive
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          // stream closed
        }
      }, 15000);

      request.signal.addEventListener('abort', () => {
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
