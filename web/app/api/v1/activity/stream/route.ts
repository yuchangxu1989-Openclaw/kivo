import { getActivityReplay, getActivityEventsSince, getActivityFeedData } from '@/lib/domain-stores';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') || 'all';
  const initialLastEventId = searchParams.get('lastEventId') || request.headers.get('Last-Event-ID') || request.headers.get('last-event-id') || '';

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const feed = getActivityFeedData();
      let lastEventId = initialLastEventId || feed.items[0]?.eventId || feed.items[0]?.id || '';

      const filterItems = (items: typeof feed.items) => type === 'all'
        ? items
        : items.filter((item) => item.tags.includes(type) || item.type.includes(type));

      if (initialLastEventId) {
        const replay = getActivityReplay(initialLastEventId);
        if (replay.historyLost) {
          controller.enqueue(encoder.encode('event: history-lost\ndata: {"reason":"activity-cache-miss"}\n\n'));
        } else {
          const missed = filterItems(replay.events);
          if (missed.length > 0) {
            lastEventId = missed[missed.length - 1].eventId || missed[missed.length - 1].id;
            controller.enqueue(encoder.encode(`id: ${lastEventId}\ndata: ${JSON.stringify(missed)}\n\n`));
          }
        }
      }

      const interval = setInterval(() => {
        if (closed) return;
        try {
          const newItems = getActivityEventsSince(lastEventId);
          const filtered = filterItems(newItems);

          if (filtered.length > 0) {
            lastEventId = filtered[filtered.length - 1].eventId || filtered[filtered.length - 1].id;
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
