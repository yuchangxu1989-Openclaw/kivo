'use client';

import { FileWarning, History, Radar } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import type { ApiResponse } from '@/types';
import type { GapReportData } from '@/lib/demo-dashboard-data';

export default function GapsPage() {
  const { data, isLoading, error, mutate } = useApi<ApiResponse<GapReportData>>('/api/v1/gaps');
  const report = data?.data;

  if (isLoading) {
    return <ListPageSkeleton rows={4} />;
  }

  if (error) {
    return (
      <ErrorState
        title="缺口报告加载失败"
        description={error.message || '暂时拿不到最近的知识盲区分析。'}
        onRetry={() => void mutate()}
      />
    );
  }

  if (!report) {
    return (
      <EmptyState
        icon={Radar}
        title="还没有生成缺口报告"
        description="先让系统跑一轮未命中分析，或者去调研队列补充高频盲区，这里才会出现最近报告和历史覆盖进度。"
        primaryAction={{ label: '去调研队列', href: '/research' }}
        secondaryAction={{ label: '查看活动流', href: '/activity', variant: 'outline' }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">缺口报告</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          对应 FR-I02：展示最近的知识盲区分析，说明盲区主题、影响面，以及建议的调研方向，并保留历史报告便于追踪填补进度。
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="border-slate-200/80 bg-white/95 shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2 text-amber-600">
              <Radar className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-[0.2em]">最近报告</span>
            </div>
            <CardTitle className="text-2xl">最新缺口分析</CardTitle>
            <p className="text-sm text-muted-foreground">生成时间：{report.latestReport.generatedAt}</p>
          </CardHeader>
          <CardContent className="space-y-4">
            {report.latestReport.weakSpots.length === 0 ? (
              <EmptyState
                icon={Radar}
                title="最近这轮没有发现明显盲区"
                description="说明当前知识覆盖较稳定，可以把注意力放在活动流和冲突处理。"
                className="shadow-none"
              />
            ) : report.latestReport.weakSpots.map((spot) => (
              <div key={spot.topic} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold text-slate-950">{spot.topic}</h2>
                      <Badge variant="outline">未命中 {spot.misses} 次</Badge>
                    </div>
                    <p className="text-sm leading-6 text-slate-700">建议调研方向：{spot.suggestion}</p>
                  </div>
                  <Badge variant="secondary">{spot.progress}</Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardHeader>
              <div className="flex items-center gap-2 text-indigo-600">
                <FileWarning className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-[0.2em]">解读</span>
              </div>
              <CardTitle className="text-xl">影响面怎么看</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
              <p>影响面来自“高频未命中查询次数”。次数高，说明 Agent 反复在这些主题上拿不到答案。</p>
              <p>盲区不等于要立刻补完，优先看未命中频率与业务影响，再决定是否触发手动调研。</p>
            </CardContent>
          </Card>

          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardHeader>
              <div className="flex items-center gap-2 text-slate-700">
                <History className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-[0.2em]">历史报告</span>
              </div>
              <CardTitle className="text-xl">填补进度</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {report.historyReports.length === 0 ? (
                <EmptyState
                  icon={History}
                  title="还没有历史报告"
                  description="后续每轮盲区分析完成后，这里会开始累积历史覆盖进度。"
                  className="shadow-none"
                />
              ) : report.historyReports.map((item) => (
                <div key={`${item.date}-${item.title}`} className="rounded-2xl border border-slate-100 bg-slate-50/80 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{item.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{item.date}</p>
                    </div>
                    <Badge variant="outline">{item.coverage}</Badge>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
