import { NextRequest, NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import { getRecentActivityFromDb } from '@/lib/activity-db';
import type { ApiResponse } from '@/types';
import type { ActivityFeedData } from '@/lib/demo-dashboard-data';

const activityFilters = [
  { key: 'all', label: '全部事件' },
  { key: 'knowledge', label: '知识条目变动' },
  { key: 'import', label: '文档导入' },
  { key: 'research', label: '调研完成' },
  { key: 'governance', label: '治理运行' },
  { key: 'embedding', label: '向量化批次' },
];

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'all';
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));

    const items = getRecentActivityFromDb(limit, type);

    const response: ApiResponse<ActivityFeedData> = {
      data: {
        filters: activityFilters,
        items,
      },
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
