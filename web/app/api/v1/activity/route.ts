import { NextRequest, NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import { getActivityFeedData, getActivityEventsSince } from '@/lib/domain-stores';
import type { ActivityFeedData } from '@/lib/domain-stores';
import type { ApiResponse } from '@/types';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const since = searchParams.get('since') || undefined;
    const type = searchParams.get('type') || 'all';

    const fullFeed = getActivityFeedData();
    const items = since ? getActivityEventsSince(since) : fullFeed.items;
    const filteredItems = type === 'all'
      ? items
      : items.filter((item) => item.tags.includes(type) || item.type.includes(type));

    const response: ApiResponse<ActivityFeedData> = {
      data: {
        filters: fullFeed.filters,
        items: filteredItems,
      },
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
