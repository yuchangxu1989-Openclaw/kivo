'use client';

import { useApi } from '@/hooks/use-api';
import { AlertTriangle, Bell, CheckCircle2, Clock, Shield } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import type { ApiResponse } from '@/types';

interface DistributionAlert {
  id: string;
  ruleId: string;
  error: string;
  timestamp: string;
  handled: boolean;
}

export default function RulesPage() {
  const { data, isLoading, error, mutate } = useApi<ApiResponse<DistributionAlert[]>>('/api/v1/rules/alerts');

  if (isLoading) return <ListPageSkeleton rows={4} />;

  if (error) {
    return (
      <ErrorState
        title="规则告警加载失败"
        description={error.message || '暂时无法获取告警数据。'}
        onRetry={() => void mutate()}
      />
    );
  }

  const alerts = data?.data ?? [];
  const unhandledCount = alerts.filter((a) => !a.handled).length;

  if (alerts.length === 0) {
    return (
      <EmptyState
        icon={Shield}
        title="暂无规则告警"
        description="规则分发运行正常，没有未处理的告警。"
        primaryAction={{ label: '返回总览', href: '/dashboard' }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900">规则分发</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            规则分发状态和未处理告警列表。
          </p>
        </div>
        {unhandledCount > 0 && (
          <Badge variant="destructive" className="flex items-center gap-1 px-3 py-1 text-sm">
            <Bell className="h-3.5 w-3.5" />
            {unhandledCount} 条未处理
          </Badge>
        )}
      </div>

      <div className="space-y-3">
        {alerts.map((alert) => (
          <Card
            key={alert.id}
            className="border-slate-200/80 bg-white/95 shadow-sm"
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {alert.handled ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                    )}
                    <span className="text-sm font-medium text-slate-900">
                      规则 {alert.ruleId}
                    </span>
                    <Badge variant={alert.handled ? 'outline' : 'destructive'}>
                      {alert.handled ? '已处理' : '未处理'}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-sm text-muted-foreground line-clamp-2">
                    {alert.error}
                  </p>
                  <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {new Date(alert.timestamp).toLocaleString('zh-CN', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
