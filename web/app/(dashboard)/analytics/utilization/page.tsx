'use client';

import { BarChart3, MoonStar, SearchX, TrendingUp } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Badge } from '@/components/ui/badge';
import { typeLabel } from '@/lib/i18n-labels';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import type { ApiResponse } from '@/types';
import type { UtilizationAnalyticsData } from '@/lib/demo-dashboard-data';

export default function UtilizationAnalyticsPage() {
  const { data, isLoading, error, mutate } = useApi<ApiResponse<UtilizationAnalyticsData>>('/api/v1/analytics/utilization');
  const analytics = data?.data;
  const topUsed = analytics?.topUsed ?? [];
  const sleepingKnowledge = analytics?.sleepingKnowledge ?? [];
  const missedQueries = analytics?.missedQueries ?? [];

  if (isLoading) {
    return <ListPageSkeleton rows={4} />;
  }

  if (error) {
    return (
      <ErrorState
        title="知识利用率统计加载失败"
        description={error.message || '暂时拿不到命中率和未命中数据。'}
        onRetry={() => void mutate()}
      />
    );
  }

  if (!analytics) {
    return (
      <EmptyState
        icon={BarChart3}
        title="还没有可分析的利用率数据"
        description="等系统累计一段时间的命中日志后，这里才会出现高频知识、沉睡条目和未命中查询。"
        primaryAction={{ label: '去语义搜索', href: '/search' }}
        secondaryAction={{ label: '回总览', href: '/dashboard', variant: 'outline' }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">知识利用率统计</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          FR-K02：展示最近 N 天被命中最多的知识、从未被命中的沉睡条目，以及高频未命中查询。
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="border-slate-200/80 bg-white/95 shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2 text-indigo-600">
              <TrendingUp className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-[0.2em]">Top-N</span>
            </div>
            <CardTitle className="text-2xl">最近 7 天命中最多的知识</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {topUsed.length === 0 ? (
              <EmptyState
                icon={TrendingUp}
                title="最近 7 天还没有命中记录"
                description="等更多搜索和注入请求发生后，这里会显示高频知识排行。"
                className="shadow-none"
              />
            ) : topUsed.map((item, index) => (
              <div key={item.name} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700">
                        {index + 1}
                      </span>
                      <Badge variant="secondary">{typeLabel(item.type)}</Badge>
                    </div>
                    <p className="text-sm leading-6 text-slate-800">{item.name}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-semibold text-slate-950">{item.hits}</p>
                    <p className="text-xs text-muted-foreground">命中次数</p>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardHeader>
              <div className="flex items-center gap-2 text-slate-700">
                <MoonStar className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-[0.2em]">沉睡知识</span>
              </div>
              <CardTitle className="text-xl">从未被命中的条目</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {sleepingKnowledge.length === 0 ? (
                <EmptyState
                  icon={MoonStar}
                  title="暂时没有沉睡知识"
                  description="当前每条知识都至少被命中过一次。"
                  className="shadow-none"
                />
              ) : sleepingKnowledge.map((item) => (
                <div key={item} className="rounded-2xl border border-slate-100 bg-slate-50/80 px-4 py-3 text-sm text-slate-700">
                  {item}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardHeader>
              <div className="flex items-center gap-2 text-rose-600">
                <SearchX className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-[0.2em]">未命中查询</span>
              </div>
              <CardTitle className="text-xl">Agent 问了但库里没答上的</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {missedQueries.length === 0 ? (
                <EmptyState
                  icon={SearchX}
                  title="最近没有高频未命中查询"
                  description="说明当前知识库对最近的请求覆盖还不错。"
                  className="shadow-none"
                />
              ) : missedQueries.map((item) => (
                <div key={item.query} className="rounded-2xl border border-rose-100 bg-rose-50/80 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-rose-900">{item.query}</p>
                    <Badge variant="outline">{item.count} 次</Badge>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="border-slate-200/80 bg-slate-950 text-white shadow-sm">
        <CardContent className="flex items-center gap-3 p-6 text-sm leading-6 text-slate-300">
          <BarChart3 className="h-5 w-5 shrink-0 text-indigo-300" />
          命中率统计已通过 `/api/v1/analytics/utilization` 走动态 API，可替换成真实日志聚合结果。
        </CardContent>
      </Card>
    </div>
  );
}
