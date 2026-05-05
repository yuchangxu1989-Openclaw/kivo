import { getActivityEventsSince, getActivityFeedData } from '@/lib/domain-stores';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') || 'all';

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const feed = getActivityFeedData();
      let lastEventId = feed.items[0]?.id ?? '';

      const interval = setInterval(() => {
        if (closed) return;
        try {
          const newItems = getActivityEventsSince(lastEventId);
          const filtered = type === 'all'
            ? newItems
            : newItems.filter((item) => item.tags.includes(type) || item.type.includes(type));

          if (filtered.length > 0) {
            lastEventId = filtered[0].id;
            const data = JSON.stringify(filtered);
            controller.enqueue(encoder.encode(`id: ${lastEventId}\ndata: ${data}\n\n`));
          } else {
            controller.enqueue(encoder.encode(`: heartbeat\n\n`));
          }
        } catch {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        }
      }, 5000);

      request.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(interval);
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
