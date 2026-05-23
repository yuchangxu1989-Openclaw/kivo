'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DashboardSkeleton, EmptyState, ErrorState } from '@/components/ui/page-states';
import { useApi } from '@/hooks/use-api';
import { useWorkbenchStore } from '@/lib/workbench-store';
import {
  Activity,
  BookOpen,
  Library,
  PlusCircle,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import type { ApiResponse, DashboardSummary } from '@/types';
import { typeLabel } from '@/lib/i18n-labels';
import { withBasePath } from '@/lib/client-api';

function MetricCard({ label, value, icon: Icon, trend, description }: { label: string; value: string | number; icon: typeof Activity; trend?: { percent: number; direction: 'up' | 'down' | 'flat' }; description?: string }) {
  return (
    <Card className="border-slate-200 bg-white shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-slate-500">{label}</span>
          <Icon className="h-5 w-5 text-indigo-500" />
        </div>
        <p className="mt-2 text-3xl font-semibold text-slate-900">{value}</p>
        {trend && trend.direction !== 'flat' && (
          <div className="mt-1 flex items-center gap-1 text-xs">
            {trend.direction === 'up' ? <TrendingUp className="h-3 w-3 text-emerald-500" /> : <TrendingDown className="h-3 w-3 text-red-400" />}
            <span className={trend.direction === 'up' ? 'text-emerald-600' : 'text-red-500'}>较上周 {trend.direction === 'up' ? '+' : '-'}{trend.percent}%</span>
          </div>
        )}
        {description && <p className="mt-1 text-xs text-slate-600">{description}</p>}
      </CardContent>
    </Card>
  );
}

function TypeDistributionBar({ label, value, total }: { label: string; value: number; total: number }) {
  const width = total > 0 ? Math.max((value / total) * 100, value > 0 ? 5 : 0) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-600">{label}</span>
        <span className="font-medium text-slate-900">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-indigo-500" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { data, isLoading, error, mutate } = useApi<ApiResponse<DashboardSummary>>('/api/v1/dashboard/summary');
  const hasHydrated = useWorkbenchStore((state) => state.hasHydrated);

  const summary = data?.data;

  const typeDistribution = useMemo(() => {
    if (!summary?.activeByType) return [];
    return Object.entries(summary.activeByType)
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [summary]);

  const totalTypeCount = useMemo(() => {
    return typeDistribution.reduce((acc, [, value]) => acc + value, 0);
  }, [typeDistribution]);

  if (isLoading || !hasHydrated) return <DashboardSkeleton />;

  if (error) {
    return <ErrorState title="仪表盘加载失败" description={error.message || '暂时拿不到数据，请稍后重试。'} onRetry={() => void mutate()} />;
  }

  if (!summary) {
    return (
      <div className="space-y-6">
        <EmptyState
          title="知识库还没有数据"
          description="先录入第一批知识条目，仪表盘会自动展示统计信息。"
          primaryAction={{ label: '前往知识库', href: '/knowledge' }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">仪表盘</h1>
        <p className="text-sm text-slate-500">知识库运行状态概览</p>
      </div>

      {/* Core metrics: FR-W01 AC1 */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="知识总量"
          value={summary.totalEntries}
          icon={BookOpen}
          trend={summary.trends.totalEntries}
        />
        <MetricCard
          label="领域知识库"
          value={summary.wikiSpaceCount}
          icon={Library}
          description="个领域知识库"
        />
        <MetricCard
          label="本周新增"
          value={summary.weeklyNewEntries}
          icon={PlusCircle}
          trend={summary.trends.weeklyNewEntries}
        />
        <MetricCard
          label="图谱节点"
          value={summary.graph?.nodes ?? 0}
          icon={Activity}
          description={`${summary.graph?.edges ?? 0} 条关系边`}
        />
      </div>

      {/* Type distribution: FR-W01 AC1 */}
      <Card className="border-slate-200 bg-white shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-slate-900">知识类型分布</CardTitle>
          <p className="text-sm text-slate-500">按类型统计的活跃知识条目数量</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {typeDistribution.length === 0 ? (
            <p className="text-sm text-slate-500">暂无类型分布数据</p>
          ) : (
            typeDistribution.map(([label, value]) => (
              <TypeDistributionBar key={label} label={typeLabel(label)} value={value} total={totalTypeCount} />
            ))
          )}
        </CardContent>
      </Card>

      {/* Wiki spaces summary cards: FR-W01 AC4 */}
      {summary.wikiSpaces.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">领域知识库</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {summary.wikiSpaces.map((space) => (
              <Link key={space.id} href={withBasePath(`/wiki/${space.id}`)}>
                <Card className="border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md cursor-pointer">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2">
                      {space.icon && <span className="text-lg">{space.icon}</span>}
                      <span className="font-medium text-slate-900">{space.title}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-sm text-slate-500">
                      <span>{space.entryCount} 条知识</span>
                      <span>{new Date(space.updatedAt).toLocaleDateString('zh-CN')}</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
