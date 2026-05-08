'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DashboardSkeleton, EmptyState, ErrorState } from '@/components/ui/page-states';
import { OnboardingGuideCard } from '@/components/onboarding-guide-card';
import { useApi } from '@/hooks/use-api';
import { useWorkbenchStore } from '@/lib/workbench-store';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Clock3,
  FlaskConical,
  PencilLine,
  ShieldCheck,
} from 'lucide-react';
import type { ApiResponse, DashboardSummary } from '@/types';
import { useCognitiveMode } from '@/contexts/cognitive-mode-context';
import { CognitivePanel } from '@/components/cognitive-panel';
import { Sparkline } from '@/components/overview-charts';

interface KnowledgeEntry {
  id: string;
  content: string;
  status: string;
  type: string;
  confidence?: number;
  createdAt?: string;
  updatedAt: string;
}

interface ConflictItem {
  id: string;
  summaryA: string;
  summaryB: string;
  conflictType: string;
  detectedAt: string;
  status: 'unresolved' | 'resolved';
  resolution?: {
    strategy: string;
    reason?: string;
    decidedAt?: string;
    resolvedAt?: string;
  };
}

interface ResearchTask {
  id: string;
  topic: string;
  scope: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  priority: '高' | '中' | '低';
  createdAt: string;
}

interface ResearchDashboardData {
  autoResearchPaused: boolean;
  tasks: ResearchTask[];
}

function formatTimeLabel(value?: string) {
  if (!value) return '刚刚';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shorten(text: string, max = 56) {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}…`;
}

function statusLabel(status: string) {
  const mapping: Record<string, string> = {
    active: '活跃',
    unresolved: '待裁决',
    resolved: '已解决',
    queued: '待调研',
    running: '进行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };

  return mapping[status] ?? status;
}

function TimelineItem({
  title,
  meta,
  badge,
  primaryHref,
  secondaryHref,
  secondaryLabel,
}: {
  title: string;
  meta: string;
  badge?: string;
  primaryHref: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white px-4 py-3 transition-colors hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600">
      <div className="flex items-start gap-3">
        <div className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{title}</p>
            {badge && <Badge variant="outline">{badge}</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock3 className="h-3.5 w-3.5" />
              {meta}
            </span>
            <Link href={primaryHref} className="font-medium text-slate-700 hover:text-slate-950 dark:text-slate-300 dark:hover:text-white">
              查看
            </Link>
            {secondaryHref && secondaryLabel && (
              <Link href={secondaryHref} className="font-medium text-indigo-600 hover:text-indigo-500">
                {secondaryLabel}
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function HealthBar({ label, value, total, tone, href }: { label: string; value: number; total: number; tone: string; href?: string }) {
  const width = total > 0 ? Math.max((value / total) * 100, value > 0 ? 8 : 0) : 0;

  const inner = (
    <div className={`space-y-2${href ? ' cursor-pointer rounded-lg px-2 py-1 -mx-2 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800' : ''}`}>
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-700 dark:text-slate-300">{label}</span>
        <span className="font-medium text-slate-950 dark:text-white">{value}</span>
      </div>
      <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-700">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="block no-underline">
        {inner}
      </a>
    );
  }

  return inner;
}

export default function DashboardPage() {
  const { data, isLoading, error, mutate } = useApi<ApiResponse<DashboardSummary>>('/api/v1/dashboard/summary');
  const { data: knowledgeData } = useApi<ApiResponse<KnowledgeEntry[]>>('/api/v1/knowledge?page=1&pageSize=5&sort=-updatedAt');
  const { data: resolvedConflictData } = useApi<ApiResponse<ConflictItem[]>>('/api/v1/conflicts?status=resolved&page=1&pageSize=3');
  const { data: researchData } = useApi<ApiResponse<ResearchDashboardData>>('/api/v1/research');

  const summary = data?.data;
  const hasHydrated = useWorkbenchStore((state) => state.hasHydrated);
  const onboardingCompleted = useWorkbenchStore((state) => state.onboardingCompleted);
  const { isOverview } = useCognitiveMode();

  const growthData = useMemo(() => summary?.growth.last7Days.map((item) => item.count) ?? [], [summary]);
  const knowledgeEntries = knowledgeData?.data ?? [];

  if (isLoading || !hasHydrated) {
    return <DashboardSkeleton />;
  }

  if (error) {
    return (
      <ErrorState
        title="知识库总览加载失败"
        description={error.message || '暂时拿不到总览数据，请稍后重试。'}
        onRetry={() => void mutate()}
      />
    );
  }

  if (!summary) {
    return (
      <div className="space-y-6">
        {!onboardingCompleted && <OnboardingGuideCard compact />}
        <EmptyState
          title="知识库里还没有可展示的总览数据"
          description="先录入第一批知识条目，或者去调研队列触发补数，总览页才会出现最近工作和健康状态。"
          primaryAction={{ label: '前往知识库', href: '/knowledge' }}
          secondaryAction={{ label: '去调研队列', href: '/research', variant: 'outline' }}
        />
      </div>
    );
  }

  const recentKnowledge = knowledgeEntries.slice(0, 5);
  const resolvedConflicts = (resolvedConflictData?.data ?? []).slice(0, 3);
  const activeResearch = (researchData?.data?.tasks ?? [])
    .filter((task) => task.status === 'running' || task.status === 'queued')
    .slice(0, 3);

  const confidenceBuckets = summary.confidenceBuckets;
  const healthyActiveRate = summary.totalEntries > 0 ? Math.round(((summary.byStatus.active ?? 0) / summary.totalEntries) * 100) : 0;

  return (
    <div className="space-y-6 pb-4">
      {!onboardingCompleted && <OnboardingGuideCard compact />}

      <section className="rounded-3xl border border-slate-200/80 bg-white px-5 py-4 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">最近工作</h1>
            <p className="text-sm text-muted-foreground">你最近编辑的知识、解决的冲突和进行中的调研，都在这里。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Link href="/knowledge" className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
              知识 {summary.totalEntries} 条
            </Link>
            <Link href="/conflicts" className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
              冲突 {summary.health.unresolvedConflicts} 个
            </Link>
            <Link href="/research" className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
              调研 {(researchData?.data?.tasks ?? []).length} 项
            </Link>
          </div>
        </div>
      </section>

      {/* Overview mode: Knowledge growth trend */}
      <CognitivePanel visible={isOverview}>
        <section className="rounded-3xl border border-slate-200/80 bg-white px-5 py-4 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:px-6">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">知识增长趋势</p>
              <p className="text-xs text-muted-foreground">最近 7 天每日新增条目数</p>
            </div>
            <Sparkline data={growthData} width={200} height={40} color="#6366f1" label="知识增长趋势" />
          </div>
        </section>
      </CognitivePanel>

      <div className="grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
        <section className="space-y-4">
          <Card className="border-slate-200/80 bg-white/95 shadow-sm dark:border-slate-700 dark:bg-slate-900/95">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                <BookOpen className="h-4 w-4" />
                <span className="text-sm font-medium">最近编辑的知识</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {recentKnowledge.length === 0 ? (
                <p className="text-sm text-muted-foreground">还没有最近编辑记录，先去创建第一条知识。</p>
              ) : (
                recentKnowledge.map((entry) => (
                  <TimelineItem
                    key={entry.id}
                    title={shorten(entry.content)}
                    meta={formatTimeLabel(entry.updatedAt)}
                    badge={statusLabel(entry.status)}
                    primaryHref={`/knowledge/${entry.id}`}
                    secondaryHref={`/knowledge/${entry.id}`}
                    secondaryLabel="编辑"
                  />
                ))
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200/80 bg-white/95 shadow-sm dark:border-slate-700 dark:bg-slate-900/95">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                <CheckCircle2 className="h-4 w-4" />
                <span className="text-sm font-medium">最近解决的冲突</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {resolvedConflicts.length === 0 ? (
                <p className="text-sm text-muted-foreground">最近还没有新的裁决记录，当前注意力先放在知识和调研上。</p>
              ) : (
                resolvedConflicts.map((conflict) => (
                  <TimelineItem
                    key={conflict.id}
                    title={shorten(conflict.resolution?.reason || `${conflict.summaryA} / ${conflict.summaryB}`)}
                    meta={formatTimeLabel(conflict.resolution?.resolvedAt || conflict.resolution?.decidedAt || conflict.detectedAt)}
                    badge={statusLabel(conflict.status)}
                    primaryHref="/conflicts"
                    secondaryHref="/conflicts"
                    secondaryLabel="复核"
                  />
                ))
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200/80 bg-white/95 shadow-sm dark:border-slate-700 dark:bg-slate-900/95">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                <FlaskConical className="h-4 w-4" />
                <span className="text-sm font-medium">进行中的调研</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {activeResearch.length === 0 ? (
                <p className="text-sm text-muted-foreground">当前没有进行中的调研任务，需要时可以手动创建一项。</p>
              ) : (
                activeResearch.map((task) => (
                  <TimelineItem
                    key={task.id}
                    title={shorten(task.topic)}
                    meta={task.createdAt}
                    badge={statusLabel(task.status)}
                    primaryHref="/research"
                    secondaryHref="/research"
                    secondaryLabel="调整"
                  />
                ))
              )}
            </CardContent>
          </Card>
        </section>

        <aside className="space-y-4">
          <Card className="border-slate-200/80 bg-white/95 shadow-sm dark:border-slate-700 dark:bg-slate-900/95">
            <CardHeader className="space-y-2 pb-3">
              <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                <ShieldCheck className="h-4 w-4" />
                <span className="text-sm font-medium">知识健康度</span>
              </div>
              <CardTitle className="text-xl dark:text-white">置信度分布</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <HealthBar label="高置信" value={confidenceBuckets.high} total={summary.totalEntries} tone="bg-emerald-500" href="/kivo/knowledge" />
              <HealthBar label="中置信" value={confidenceBuckets.medium} total={summary.totalEntries} tone="bg-amber-500" href="/kivo/knowledge" />
              <HealthBar label="低置信" value={confidenceBuckets.low} total={summary.totalEntries} tone="bg-rose-500" href="/kivo/knowledge" />
              {confidenceBuckets.unknown > 0 && (
                <HealthBar label="未标注" value={confidenceBuckets.unknown} total={summary.totalEntries} tone="bg-slate-400" href="/kivo/knowledge" />
              )}
              <a href="/kivo/knowledge?status=active" target="_blank" rel="noopener noreferrer" className="block no-underline">
                <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700 cursor-pointer transition-colors hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
                  当前活跃条目占比 <span className="font-semibold text-slate-950 dark:text-white">{healthyActiveRate}%</span>
                </div>
              </a>
            </CardContent>
          </Card>

          <Card className="border-slate-200/80 bg-white/95 shadow-sm dark:border-slate-700 dark:bg-slate-900/95">
            <CardHeader className="space-y-2 pb-3">
              <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                <AlertTriangle className="h-4 w-4" />
                <span className="text-sm font-medium">过期预警</span>
              </div>
              <CardTitle className="text-xl dark:text-white">需要你处理的条目</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="rounded-2xl border border-slate-200 px-4 py-3 text-slate-700 dark:border-slate-700 dark:text-slate-300">
                <p className="font-medium text-slate-950 dark:text-white">下一步</p>
                <p className="mt-1 leading-6">{summary.nextAction.description}</p>
                <Link href={summary.nextAction.href} className="mt-3 inline-flex items-center gap-1 font-medium text-indigo-600 hover:text-indigo-500">
                  继续处理
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200/80 bg-white/95 shadow-sm dark:border-slate-700 dark:bg-slate-900/95">
            <CardContent className="space-y-3 p-5">
              <p className="text-sm font-medium text-slate-950 dark:text-white">工作台入口</p>
              <div className="flex flex-wrap gap-2 text-sm">
                <Link href="/search" className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1.5 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                  搜索
                </Link>
                <Link href="/graph" className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1.5 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                  图谱
                </Link>
                <Link href="/activity" className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1.5 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                  活动
                </Link>
                <Link href="/knowledge/import" className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1.5 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                  导入
                </Link>
                <Link href="/knowledge" className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1.5 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                  <PencilLine className="h-3.5 w-3.5" />
                  编辑知识
                </Link>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
