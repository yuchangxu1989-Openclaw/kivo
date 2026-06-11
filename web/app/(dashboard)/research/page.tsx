'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ExternalLink,
  FileText,
  FlaskConical,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import type { ApiResponse } from '@/types';
import type {
  ResearchDashboardData,
  ResearchReport,
  ResearchStatus,
  ResearchTopic,
  ResearchWikiEntryLink,
} from '@/lib/domain-types';

const STATUS_LABELS: Record<ResearchStatus, string> = {
  queued: '进行中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const STATUS_CLASSES: Record<ResearchStatus, string> = {
  queued: 'border-blue-200 bg-blue-50 text-blue-800',
  running: 'border-blue-200 bg-blue-50 text-blue-800',
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  failed: 'border-rose-200 bg-rose-50 text-rose-800',
  cancelled: 'border-slate-200 bg-slate-50 text-slate-700',
};

const STATUS_ORDER: ResearchStatus[] = ['running', 'completed', 'failed', 'cancelled'];

function formatTimestamp(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '未记录';
  if (typeof value === 'number') return new Date(value).toLocaleString('zh-CN');

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString('zh-CN');
}

function entryCount(report: ResearchReport): number {
  return report.wikiEntryCount ?? report.wikiEntries?.length ?? report.entryIds?.length ?? 0;
}

function visibleEntries(report: ResearchReport): ResearchWikiEntryLink[] {
  if (report.wikiEntries?.length) return report.wikiEntries;
  return (report.entryIds ?? []).map((id) => ({ id }));
}

function normalizeTopics(data: ResearchDashboardData | undefined): ResearchTopic[] {
  if (!data) return [];
  if (Array.isArray(data.topics) && data.topics.length > 0) return data.topics;

  const byTopic = new Map<string, ResearchTopic>();
  for (const legacy of data.tasks ?? []) {
    const name = (legacy.topic || '未命名主题').trim();
    const topicId = `legacy-${name}`;
    const reportUri = legacy.resultSummary?.match(/[（(]([^（）()]+)[）)]$/)?.[1];
    const reports: ResearchReport[] = reportUri
      ? [{
          id: `${legacy.id}-report`,
          title: `${name} 调研报告`,
          reportUri,
          isReference: Boolean(legacy.adopted),
          wikiEntryCount: legacy.knowledgeCount ?? legacy.resultEntryIds?.length ?? 0,
          entryIds: legacy.resultEntryIds,
          referenceBatches: [],
        }]
      : [];

    const topic = byTopic.get(topicId) ?? {
      id: topicId,
      name,
      normalizedName: topicId,
      createdAt: legacy.createdAt,
      updatedAt: legacy.createdAt,
      taskCount: 0,
      reportCount: 0,
      referenceReportCount: 0,
      wikiEntryCount: 0,
      tasks: [],
    };

    topic.tasks.push({
      id: legacy.id,
      title: legacy.scope || name,
      query: null,
      status: legacy.status,
      sourceType: null,
      sourceRef: null,
      actorId: null,
      executorId: null,
      createdAt: legacy.createdAt,
      updatedAt: legacy.createdAt,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      failureReason: legacy.failureReason,
      reportPath: null,
      resultPath: null,
      reports,
    });
    topic.taskCount = topic.tasks.length;
    topic.reportCount = topic.tasks.reduce((sum, task) => sum + (task.reports?.length ?? 0), 0);
    topic.referenceReportCount = topic.tasks.reduce(
      (sum, task) => sum + (task.reports ?? []).filter((report) => report.isReference).length,
      0,
    );
    topic.wikiEntryCount = topic.tasks.reduce(
      (sum, task) => sum + (task.reports ?? []).reduce((inner, report) => inner + entryCount(report), 0),
      0,
    );
    byTopic.set(topicId, topic);
  }

  return Array.from(byTopic.values());
}

function safeReportHref(report: ResearchReport): string | null {
  const uri = report.reportUri.trim();
  if (!uri) return null;
  if (uri.startsWith('/')) return uri;

  try {
    const parsed = new URL(uri);
    return ['https:', 'http:', 'feishu:', 'file:'].includes(parsed.protocol) ? uri : null;
  } catch {
    return null;
  }
}

function StatusBadge({ status }: { status: ResearchStatus }) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_CLASSES[status] ?? STATUS_CLASSES.running}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function ReportEntryLinks({ report }: { report: ResearchReport }) {
  const entries = visibleEntries(report);
  const count = entryCount(report);

  if (!report.isReference) {
    return <span className="text-xs text-slate-600">未标记为可参考，未展示入库入口。</span>;
  }

  if (count === 0) {
    return <span className="text-xs text-slate-600">已标记为可参考，暂无已入库 Wiki 条目。</span>;
  }

  return (
    <div className="space-y-2">
      <Link
        href={`/knowledge?researchReportId=${encodeURIComponent(report.id)}`}
        className="inline-flex items-center gap-1 text-sm font-medium text-slate-950 underline decoration-slate-300 underline-offset-4 hover:decoration-slate-950"
      >
        <BookOpen className="h-4 w-4" />
        查看 {count} 条已入库 Wiki 条目
      </Link>
      {entries.length > 0 && (
        <ul className="space-y-1 text-sm text-slate-700">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <Link href={`/knowledge/${encodeURIComponent(entry.id)}`} className="font-medium text-slate-950 hover:underline">
                {entry.title || entry.id}
              </Link>
              {entry.summary && <p className="mt-1 text-xs leading-5 text-slate-600">{entry.summary}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ResearchPage() {
  const { data, isLoading, error, mutate, isValidating } = useApi<ApiResponse<ResearchDashboardData>>('/api/v1/research', {
    refreshInterval: 3000,
    revalidateOnFocus: true,
  });
  const topics = useMemo(() => normalizeTopics(data?.data), [data]);
  const [notice, setNotice] = useState('');
  const [pendingReportId, setPendingReportId] = useState<string | null>(null);

  const totals = useMemo(() => {
    const taskCounts = new Map<ResearchStatus, number>(STATUS_ORDER.map((status) => [status, 0]));
    let reportCount = 0;
    let referenceReportCount = 0;
    let wikiEntryCount = 0;

    for (const topic of topics) {
      for (const task of topic.tasks) {
        const normalized = task.status === 'queued' ? 'running' : task.status;
        taskCounts.set(normalized, (taskCounts.get(normalized) ?? 0) + 1);
        reportCount += task.reports?.length ?? 0;
        for (const report of task.reports ?? []) {
          if (report.isReference) referenceReportCount += 1;
          wikiEntryCount += entryCount(report);
        }
      }
    }

    return { taskCounts, reportCount, referenceReportCount, wikiEntryCount };
  }, [topics]);

  async function markReportReference(report: ResearchReport) {
    setPendingReportId(report.id);
    setNotice('');
    try {
      await apiFetch(`/api/v1/research/reports/${encodeURIComponent(report.id)}/reference`, {
        method: 'POST',
        body: JSON.stringify({ confirmedBy: 'kivo-web', forceReextract: false }),
      });
      setNotice(`已将「${report.title}」标记为可参考。`);
      await mutate();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '标记可参考失败。');
    } finally {
      setPendingReportId(null);
    }
  }

  if (isLoading) {
    return <ListPageSkeleton filters={1} rows={4} />;
  }

  if (error) {
    return (
      <ErrorState
        title="调研登记簿加载失败"
        description={error.message || '暂时拿不到调研登记簿数据。'}
        onRetry={() => void mutate()}
      />
    );
  }

  return (
    <div className="min-h-screen space-y-6 bg-white text-slate-950">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">调研登记簿</h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-700">
            按主题查看调研任务、报告状态、可参考标签，以及报告沉淀到 Wiki 的追溯入口。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700">
            {isValidating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            每 3 秒自动刷新
          </span>
          <Button variant="outline" size="sm" onClick={() => void mutate()}>
            <RefreshCw className="mr-1.5 h-4 w-4" />立即刷新
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <Card className="border-slate-200 bg-white shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-600">主题</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-semibold text-slate-950">{topics.length}</p></CardContent>
        </Card>
        {STATUS_ORDER.map((status) => (
          <Card key={status} className="border-slate-200 bg-white shadow-sm">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-600">{STATUS_LABELS[status]}</CardTitle></CardHeader>
            <CardContent><p className="text-3xl font-semibold text-slate-950">{totals.taskCounts.get(status) ?? 0}</p></CardContent>
          </Card>
        ))}
        <Card className="border-slate-200 bg-white shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-600">可参考报告</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-semibold text-slate-950">{totals.referenceReportCount}</p></CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-slate-200 bg-white shadow-sm">
          <CardContent className="p-4">
            <p className="text-sm text-slate-600">报告总数</p>
            <p className="mt-1 text-2xl font-semibold text-slate-950">{totals.reportCount}</p>
          </CardContent>
        </Card>
        <Card className="border-slate-200 bg-white shadow-sm">
          <CardContent className="p-4">
            <p className="text-sm text-slate-600">已入库 Wiki 条目</p>
            <p className="mt-1 text-2xl font-semibold text-slate-950">{totals.wikiEntryCount}</p>
          </CardContent>
        </Card>
        <Card className="border-slate-200 bg-white shadow-sm">
          <CardContent className="flex items-start gap-3 p-4 text-sm leading-6 text-slate-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-slate-600" />
            <p>本页只展示和追溯已登记内容；报告是否进入 Wiki 由“标记为可参考”确认。</p>
          </CardContent>
        </Card>
      </div>

      {notice && <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800">{notice}</p>}

      {topics.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="还没有登记的调研报告"
          description="当调研任务和报告被登记后，这里会按主题展示状态、报告链接和 Wiki 追溯入口。"
        />
      ) : (
        <div className="space-y-5">
          {topics.map((topic) => (
            <Card key={topic.id} className="border-slate-200 bg-white shadow-sm">
              <CardHeader className="border-b border-slate-100">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-2">
                    <CardTitle className="text-xl text-slate-950">{topic.name}</CardTitle>
                    {topic.description && <p className="text-sm leading-6 text-slate-700">{topic.description}</p>}
                    <p className="text-xs text-slate-600">
                      创建：{formatTimestamp(topic.createdAt)} · 更新：{formatTimestamp(topic.updatedAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline" className="bg-white text-slate-800">任务 {topic.taskCount ?? topic.tasks.length}</Badge>
                    <Badge variant="outline" className="bg-white text-slate-800">报告 {topic.reportCount ?? topic.tasks.reduce((sum, task) => sum + (task.reports?.length ?? 0), 0)}</Badge>
                    <Badge variant="outline" className="bg-white text-slate-800">可参考 {topic.referenceReportCount ?? 0}</Badge>
                    <Badge variant="outline" className="bg-white text-slate-800">Wiki {topic.wikiEntryCount ?? 0}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 p-5">
                {topic.tasks.length === 0 ? (
                  <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">该主题下暂无任务记录。</p>
                ) : topic.tasks.map((task) => (
                  <div key={task.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-base font-semibold text-slate-950">{task.title}</h2>
                          <StatusBadge status={task.status} />
                        </div>
                        <p className="text-xs text-slate-600">
                          创建：{formatTimestamp(task.createdAt)} · 更新：{formatTimestamp(task.updatedAt)}
                          {task.executorId ? ` · 执行者：${task.executorId}` : ''}
                        </p>
                      </div>
                    </div>

                    {task.status === 'failed' && task.failureReason && (
                      <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                        失败原因：{task.failureReason}
                      </p>
                    )}

                    <div className="mt-4 space-y-3">
                      <h3 className="flex items-center gap-2 text-sm font-medium text-slate-950">
                        <FileText className="h-4 w-4" />报告
                      </h3>
                      {task.reports?.length ? task.reports.map((report) => {
                        const count = entryCount(report);
                        const href = safeReportHref(report);
                        return (
                          <div key={report.id} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                              <div className="space-y-2">
                                {href ? (
                                  <a
                                    href={href}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 font-medium text-slate-950 underline decoration-slate-300 underline-offset-4 hover:decoration-slate-950"
                                  >
                                    {report.title}<ExternalLink className="h-4 w-4" />
                                  </a>
                                ) : (
                                  <p className="font-medium text-slate-950">{report.title}</p>
                                )}
                                <p className="break-all text-xs text-slate-600">{report.reportUri}</p>
                                {!href && <Badge variant="outline" className="bg-white text-rose-800">报告链接不可打开</Badge>}
                                <div className="flex flex-wrap items-center gap-2">
                                  {report.isReference ? (
                                    <Badge className="border-emerald-200 bg-emerald-50 text-emerald-800">可参考</Badge>
                                  ) : (
                                    <Badge variant="outline" className="bg-white text-slate-700">未标记可参考</Badge>
                                  )}
                                  {report.isReference && <Badge variant="outline" className="bg-white text-slate-800">Wiki 条目 {count}</Badge>}
                                  {report.batchStatus && <Badge variant="outline" className="bg-white text-slate-800">入库状态 {report.batchStatus}</Badge>}
                                </div>
                              </div>
                              {!report.isReference && (
                                <Button
                                  size="sm"
                                  disabled={pendingReportId === report.id}
                                  onClick={() => void markReportReference(report)}
                                >
                                  {pendingReportId === report.id ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
                                  标记为可参考
                                </Button>
                              )}
                            </div>
                            {report.failureReason && (
                              <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">入库失败：{report.failureReason}</p>
                            )}
                            <ReportEntryLinks report={report} />
                          </div>
                        );
                      }) : (
                        <p className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700">暂无报告链接。</p>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
