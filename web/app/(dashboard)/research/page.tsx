'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Loader2,
  PauseCircle,
  PlayCircle,
  PlusCircle,
  Trash2,
  ChevronDown,
  ChevronUp,
  BookOpen,
  GitBranch,
  Target,
  ExternalLink,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import type { ApiResponse } from '@/types';
import type { Priority, ResearchDashboardData, ResearchStatus } from '@/lib/demo-dashboard-data';

const STATUS_LABELS: Record<ResearchStatus, string> = {
  queued: '待调研',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const STATUS_VARIANT: Record<ResearchStatus, 'outline' | 'default' | 'secondary' | 'destructive'> = {
  queued: 'outline',
  running: 'default',
  completed: 'secondary',
  failed: 'destructive',
  cancelled: 'outline',
};

const SUMMARY_STATUSES: ResearchStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled'];

type StatusFilter = 'all' | ResearchStatus;

const STATUS_FILTER_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '进行中' },
  { key: 'completed', label: '已完成' },
  { key: 'cancelled', label: '已取消' },
  { key: 'queued', label: '待调研' },
  { key: 'failed', label: '失败' },
];

const KNOWLEDGE_TYPE_OPTIONS = [
  { value: 'fact', label: '事实 (Fact)' },
  { value: 'methodology', label: '方法论 (Methodology)' },
  { value: 'experience', label: '经验 (Experience)' },
  { value: 'rule', label: '规则 (Rule)' },
  { value: 'reference', label: '参考资料 (Reference)' },
];

const PAGE_SIZE = 10;

/* ── Research Closure Panel (调研闭环可视化) ─────────────────────────────────── */

function ResearchClosurePanel({ task }: { task: ResearchDashboardData['tasks'][number] }) {
  const [expanded, setExpanded] = useState(false);
  const entryIds = task.resultEntryIds ?? [];
  const knowledgeCount = task.knowledgeCount ?? 0;

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300">
        <p>{task.resultSummary}</p>
        <p className="mt-1">已入库知识条目数：{knowledgeCount}</p>
      </div>

      {/* Closure toggle */}
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
        onClick={() => setExpanded(!expanded)}
      >
        <GitBranch className="h-3.5 w-3.5" />
        成果追踪
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {expanded && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 space-y-4 dark:border-indigo-800 dark:bg-indigo-900/20">
          {/* Step 1: Research → Knowledge entries */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-indigo-700 dark:text-indigo-300">
              <BookOpen className="h-3.5 w-3.5" />
              调研产出知识条目
            </div>
            {entryIds.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {entryIds.map((entryId) => (
                  <Link
                    key={entryId}
                    href={`/knowledge/${entryId}`}
                    className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-200 transition-colors dark:bg-indigo-900/40 dark:text-indigo-300 dark:hover:bg-indigo-900/60"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {entryId}
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">暂无关联知识条目记录。</p>
            )}
          </div>

          {/* Step 2: Graph position */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-indigo-700 dark:text-indigo-300">
              <GitBranch className="h-3.5 w-3.5" />
              图谱更新
            </div>
            {entryIds.length > 0 ? (
              <div className="flex items-center gap-2">
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  {knowledgeCount} 条知识已纳入知识图谱。
                </p>
                <Link
                  href="/graph"
                  className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  查看图谱
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">暂无图谱更新。</p>
            )}
          </div>

          {/* Step 3: Gap filled */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-indigo-700 dark:text-indigo-300">
              <Target className="h-3.5 w-3.5" />
              填补知识缺口
            </div>
            {task.filledGapTopic ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  已填补
                </span>
                <span className="text-xs text-slate-600 dark:text-slate-400">{task.filledGapTopic}</span>
                <Link
                  href="/gaps"
                  className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  查看缺口报告
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">该调研未关联特定知识缺口。</p>
            )}
          </div>

          {/* Visual flow indicator */}
          <div className="flex items-center gap-2 pt-2 border-t border-indigo-200 dark:border-indigo-800">
            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-500 text-[10px] font-bold text-white">1</span>
              调研
            </div>
            <div className="h-px flex-1 bg-indigo-300 dark:bg-indigo-700" />
            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-500 text-[10px] font-bold text-white">2</span>
              入库
            </div>
            <div className="h-px flex-1 bg-indigo-300 dark:bg-indigo-700" />
            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-white">3</span>
              图谱
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ResearchPage() {
  const { data, isLoading, error, mutate } = useApi<ApiResponse<ResearchDashboardData>>('/api/v1/research');
  const dashboard = data?.data;
  const tasks = dashboard?.tasks ?? [];
  const autoResearchPaused = dashboard?.autoResearchPaused ?? false;

  const [topic, setTopic] = useState('');
  const [scope, setScope] = useState('');
  const [priority, setPriority] = useState<Priority>('中');
  const [budget, setBudget] = useState('');
  const [expectedTypes, setExpectedTypes] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [currentPage, setCurrentPage] = useState(1);

  const grouped = useMemo(() => ({
    queued: tasks.filter((task) => task.status === 'queued'),
    running: tasks.filter((task) => task.status === 'running'),
    completed: tasks.filter((task) => task.status === 'completed'),
    failed: tasks.filter((task) => task.status === 'failed'),
    cancelled: tasks.filter((task) => task.status === 'cancelled'),
  }), [tasks]);

  const filteredTasks = useMemo(() => {
    if (statusFilter === 'all') return tasks;
    return tasks.filter((task) => task.status === statusFilter);
  }, [tasks, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredTasks.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedTasks = useMemo(
    () => filteredTasks.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredTasks, safePage],
  );

  function handleStatusFilterChange(next: StatusFilter) {
    setStatusFilter(next);
    setCurrentPage(1);
  }

  function toggleExpectedType(type: string) {
    setExpectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }

  if (isLoading) {
    return <ListPageSkeleton filters={1} rows={4} />;
  }

  if (error) {
    return (
      <ErrorState
        title="调研队列加载失败"
        description={error.message || '暂时拿不到调研任务状态。'}
        onRetry={() => void mutate()}
      />
    );
  }

  if (!dashboard) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="还没有调研任务，创建第一个来自动发现知识缺口"
        description="你可以先手动创建一个调研任务，或者等待系统根据盲区自动补数。创建后，这里会显示排队、执行和完成情况。"
        primaryAction={{ label: '回总览', href: '/dashboard' }}
        secondaryAction={{ label: '查看缺口报告', href: '/gaps', variant: 'outline' }}
      />
    );
  }

  async function createTask() {
    if (!topic.trim() || !scope.trim()) return;
    setSubmitting(true);
    const nextTopic = topic.trim();
    try {
      await apiFetch<ApiResponse<ResearchDashboardData>>('/api/v1/research', {
        method: 'POST',
        body: JSON.stringify({
          topic: nextTopic,
          scope: scope.trim(),
          priority,
          budgetCredits: budget ? Number(budget) : undefined,
          expectedTypes: expectedTypes.length > 0 ? expectedTypes : undefined,
        }),
      });
      setTopic('');
      setScope('');
      setPriority('中');
      setBudget('');
      setExpectedTypes([]);
      setNotice(`已创建调研任务「${nextTopic}」，进入队列等待执行。`);
      await mutate();
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelTask(id: string) {
    setSubmitting(true);
    try {
      await apiFetch<ApiResponse<ResearchDashboardData>>(`/api/v1/research?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      setNotice('已取消排队中的调研任务。');
      await mutate();
    } finally {
      setSubmitting(false);
    }
  }

  async function changePriority(id: string, nextPriority: Priority) {
    setSubmitting(true);
    try {
      await apiFetch<ApiResponse<ResearchDashboardData>>('/api/v1/research', {
        method: 'PATCH',
        body: JSON.stringify({ id, priority: nextPriority }),
      });
      setNotice(`任务优先级已调整为「${nextPriority}」。`);
      await mutate();
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleAutoResearch() {
    setSubmitting(true);
    const next = !autoResearchPaused;
    try {
      await apiFetch<ApiResponse<ResearchDashboardData>>('/api/v1/research', {
        method: 'PATCH',
        body: JSON.stringify({ autoResearchPaused: next }),
      });
      setNotice(next ? '自动调研已暂停。' : '自动调研已恢复。');
      await mutate();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">调研队列</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            看任务状态、手动触发调研、取消排队、调整优先级，以及暂停 / 恢复自动调研。
          </p>
        </div>
        <Button variant={autoResearchPaused ? 'default' : 'outline'} disabled={submitting} onClick={toggleAutoResearch} aria-label={autoResearchPaused ? '恢复自动调研' : '暂停自动调研'}>
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : autoResearchPaused ? <PlayCircle className="mr-2 h-4 w-4" /> : <PauseCircle className="mr-2 h-4 w-4" />}
          {autoResearchPaused ? '恢复自动调研' : '暂停自动调研'}
        </Button>
      </div>

      {/* ── Create Form ── */}
      <Card className="border-slate-200/80 bg-white/95 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl">手动触发调研</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
            <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="输入调研主题" aria-label="调研主题" />
            <Input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="描述调研范围，例如时间窗口、对象、目标" aria-label="调研范围" />
          </div>
          <div className="grid gap-4 lg:grid-cols-[180px_180px_1fr_140px]">
            <Select value={priority} onValueChange={(value) => setPriority(value as Priority)}>
              <SelectTrigger aria-label="调研任务优先级">
                <SelectValue placeholder="选择优先级" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="高">高优先级</SelectItem>
                <SelectItem value="中">中优先级</SelectItem>
                <SelectItem value="低">低优先级</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="number"
              min={0}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="预算（token 数）"
              aria-label="调研预算"
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="shrink-0 text-sm text-muted-foreground">预期知识类型：</span>
              {KNOWLEDGE_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => toggleExpectedType(opt.value)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors ${
                    expectedTypes.includes(opt.value)
                      ? 'bg-slate-950 text-white'
                      : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                  aria-pressed={expectedTypes.includes(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <Button onClick={createTask} disabled={submitting || !topic.trim() || !scope.trim()} aria-label="创建调研任务">
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlusCircle className="mr-2 h-4 w-4" />}创建任务
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">提交后会生成调研任务并进入队列。调研完成后，这里会出现结果摘要与入库条目数。</p>
          {notice && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
        </CardContent>
      </Card>

      {/* ── Summary Cards ── */}
      <div className="grid gap-4 xl:grid-cols-5">
        {SUMMARY_STATUSES.map((status) => (
          <Card key={status} className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">{STATUS_LABELS[status]}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold text-slate-950">{grouped[status].length}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Status Filter ── */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            onClick={() => handleStatusFilterChange(opt.key)}
            className={`rounded-full px-3 py-1 text-sm transition-colors ${
              statusFilter === opt.key
                ? 'bg-slate-950 text-white'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
            aria-pressed={statusFilter === opt.key}
          >
            {opt.label}
            {opt.key !== 'all' && (
              <span className="ml-1.5 text-xs opacity-70">
                {grouped[opt.key as ResearchStatus]?.length ?? 0}
              </span>
            )}
          </button>
        ))}
        <span className="ml-auto text-sm text-muted-foreground">
          共 {filteredTasks.length} 条{statusFilter !== 'all' ? `（${STATUS_FILTER_OPTIONS.find((o) => o.key === statusFilter)?.label}）` : ''}
        </span>
      </div>

      {/* ── Task List ── */}
      {paginatedTasks.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="还没有调研任务，创建第一个来自动发现知识缺口"
          description={
            statusFilter === 'all'
              ? '你可以在上方创建调研任务，或等待系统根据盲区自动补数。'
              : `当前筛选「${STATUS_FILTER_OPTIONS.find((o) => o.key === statusFilter)?.label}」下没有任务，试试切换筛选条件。`
          }
        />
      ) : (
        <div className="space-y-4">
          {paginatedTasks.map((task) => {
            const discoveredCount = task.knowledgeCount ?? 0;
            const hasExpected = task.expectedTypes && task.expectedTypes.length > 0;
            const expectedCount = hasExpected ? task.expectedTypes!.length * 3 : Math.max(discoveredCount, 1);
            const progressPercent = hasExpected
              ? Math.min(100, Math.round((discoveredCount / expectedCount) * 100))
              : (task.status === 'completed' ? 100 : 50);

            return (
              <Card key={task.id} className="border-slate-200/80 bg-white/95 shadow-sm">
                <CardContent className="space-y-4 p-5 sm:p-6">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-semibold text-slate-950">{task.topic}</h2>
                        <Badge variant={STATUS_VARIANT[task.status]}>{STATUS_LABELS[task.status]}</Badge>
                        <Badge variant="outline">优先级 {task.priority}</Badge>
                        {task.budgetCredits > 0 && (
                          <Badge variant="outline">预算 {task.budgetCredits.toLocaleString()} token</Badge>
                        )}
                      </div>
                      <p className="text-sm leading-6 text-slate-700">{task.scope}</p>
                      {task.expectedTypes && task.expectedTypes.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">预期类型：</span>
                          {task.expectedTypes.map((t) => (
                            <span key={t} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                              {KNOWLEDGE_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">创建时间：{task.createdAt}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {task.status === 'queued' && (
                        <Button variant="outline" size="sm" disabled={submitting} onClick={() => cancelTask(task.id)} aria-label={`取消调研任务 ${task.topic}`}>
                          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}取消任务
                        </Button>
                      )}
                      <Select value={task.priority} onValueChange={(value) => changePriority(task.id, value as Priority)} disabled={submitting}>
                        <SelectTrigger className="w-[132px]" aria-label={`调整 ${task.topic} 的优先级`}>
                          <SelectValue placeholder="优先级" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="高">高优先级</SelectItem>
                          <SelectItem value="中">中优先级</SelectItem>
                          <SelectItem value="低">低优先级</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* ── Progress Indicator ── */}
                  {(task.status === 'running' || task.status === 'completed') && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>已发现知识 {discoveredCount} 条{hasExpected ? ` / 预期 ${expectedCount} 条` : ''}</span>
                        <span>{progressPercent}%</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full transition-all ${
                            task.status === 'completed' ? 'bg-emerald-500' : 'bg-indigo-500'
                          }`}
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {task.status === 'completed' && (
                    <ResearchClosurePanel task={task} />
                  )}

                  {task.status === 'failed' && task.failureReason && (
                    <div className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-700">
                      <p>失败原因：{task.failureReason}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={safePage <= 1}
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            aria-label="上一页"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground">
            第 {safePage} / {totalPages} 页
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={safePage >= totalPages}
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            aria-label="下一页"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

    </div>
  );
}
