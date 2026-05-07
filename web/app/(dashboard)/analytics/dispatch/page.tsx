'use client';

import { Send, TriangleAlert, Users } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import type { ApiResponse } from '@/types';
import type { DispatchAnalyticsData } from '@/lib/demo-dashboard-data';

export default function DispatchAnalyticsPage() {
  const { data, isLoading, error, mutate } = useApi<ApiResponse<DispatchAnalyticsData>>('/api/v1/analytics/dispatch');
  const analytics = data?.data;
  const activeRules = analytics?.activeRules ?? [];
  const failedRules = analytics?.failedRules ?? [];

  if (isLoading) {
    return <ListPageSkeleton rows={4} />;
  }

  if (error) {
    return (
      <ErrorState
        title="规则分发状态加载失败"
        description={error.message || '暂时拿不到规则分发数据。'}
        onRetry={() => void mutate()}
      />
    );
  }

  if (!analytics) {
    return (
      <EmptyState
        icon={Users}
        title="当前没有可展示的规则分发数据"
        description="等规则开始分发并产生订阅统计后，这里会显示生效规则、订阅者数量和失败原因。"
        primaryAction={{ label: '回总览', href: '/dashboard' }}
        secondaryAction={{ label: '查看活动流', href: '/activity', variant: 'outline' }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">规则分发状态</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          FR-K03：展示当前生效规则、订阅者数量、最近分发时间，以及分发失败的规则与原因。
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-slate-200/80 bg-white/95 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">当前规则数</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold text-slate-950">{activeRules.length}</p>
          </CardContent>
        </Card>
        <Card className="border-slate-200/80 bg-white/95 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">总订阅者</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold text-slate-950">{activeRules.reduce((sum, item) => sum + item.subscribers, 0)}</p>
          </CardContent>
        </Card>
        <Card className="border-slate-200/80 bg-white/95 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">分发失败</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold text-rose-600">{failedRules.length}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="border-slate-200/80 bg-white/95 shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2 text-indigo-600">
              <Users className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-[0.2em]">已生效规则</span>
            </div>
            <CardTitle className="text-2xl">订阅与最近分发</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {activeRules.length === 0 ? (
              <EmptyState
                icon={Users}
                title="当前没有生效中的规则"
                description="等规则开始分发后，这里会显示订阅者数量和最近分发时间。"
                className="shadow-none"
              />
            ) : activeRules.map((rule) => (
              <div key={rule.name} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-lg font-semibold text-slate-950">{rule.name}</p>
                    <p className="mt-1 text-sm text-muted-foreground">最近分发：{rule.lastDistributedAt}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-semibold text-slate-950">{rule.subscribers}</p>
                    <p className="text-xs text-muted-foreground">订阅者</p>
                  </div>
                </div>
                <div className="mt-3">
                  <Badge variant={rule.status === '已生效' ? 'secondary' : 'outline'}>{rule.status}</Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardHeader>
              <div className="flex items-center gap-2 text-rose-600">
                <TriangleAlert className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-[0.2em]">分发失败</span>
              </div>
              <CardTitle className="text-xl">失败原因</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {failedRules.length === 0 ? (
                <EmptyState
                  icon={TriangleAlert}
                  title="最近没有分发失败"
                  description="规则分发目前状态稳定。"
                  className="shadow-none"
                />
              ) : failedRules.map((rule) => (
                <div key={rule.name} className="rounded-2xl border border-rose-100 bg-rose-50/80 px-4 py-3">
                  <p className="text-sm font-medium text-rose-900">{rule.name}</p>
                  <p className="mt-1 text-sm leading-6 text-rose-700">{rule.reason}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-slate-200/80 bg-slate-950 text-white shadow-sm">
            <CardContent className="flex items-center gap-3 p-6 text-sm leading-6 text-slate-300">
              <Send className="h-5 w-5 shrink-0 text-indigo-300" />
              规则页面只做展示，不开放编辑；当前已通过 `/api/v1/analytics/dispatch` 走动态 API。
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
