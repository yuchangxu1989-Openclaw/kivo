'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useApi } from '@/hooks/use-api';
import { withBasePath } from '@/lib/client-api';
import {
  BookOpen,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  RefreshCw,
  Shield,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import type { ApiResponse } from '@/types';

interface GovernanceReport {
  id: string;
  title: string;
  summary: string;
  status: 'completed' | 'in_progress' | 'archived';
  issuesFound: number;
  issuesResolved: number;
  createdAt: string;
}

interface GovernanceData {
  themes: Array<{ id: string; topic: string; count: number; trend: string; lastSeen: string }>;
  reports: GovernanceReport[];
  stats: {
    totalIntents: number;
    activeIntents: number;
    archivedIntents: number;
    pendingReview: number;
    avgConfidence: number;
  };
}

const STATUS_LABELS: Record<string, string> = {
  completed: '已完成',
  in_progress: '进行中',
  archived: '已归档',
};

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  in_progress: 'secondary',
  archived: 'outline',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function inferType(title: string): string {
  if (title.includes('覆盖度') || title.includes('周报')) return 'staleness';
  if (title.includes('清理') || title.includes('合并')) return 'aggregation';
  if (title.includes('审计') || title.includes('一致性')) return 'auto-govern';
  return 'auto-govern';
}

const TYPE_LABELS: Record<string, string> = {
  staleness: '过期检查',
  aggregation: '碎片聚合',
  'auto-govern': '自动治理',
};

function ReportCard({ report, onRollback }: { report: GovernanceReport; onRollback: (id: string) => Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const type = inferType(report.title);
  const progress = report.issuesFound > 0
    ? Math.round((report.issuesResolved / report.issuesFound) * 100)
    : 100;

  return (
    <Card className="border-slate-200/80 bg-white/95 shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-medium text-slate-900 truncate">
                {report.title}
              </h3>
              <Badge variant={STATUS_VARIANT[report.status] ?? 'outline'}>
                {STATUS_LABELS[report.status] ?? report.status}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {TYPE_LABELS[type] ?? type}
              </Badge>
            </div>
            <div className="mt-1.5 flex items-center gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {formatDate(report.createdAt)}
              </span>
              <span className="inline-flex items-center gap-1">
                <FileText className="h-3 w-3" />
                处理 {report.issuesFound} 条
              </span>
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                解决 {report.issuesResolved} 条
              </span>
            </div>
          </div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>

        {/* Progress bar */}
        {report.issuesFound > 0 && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
              <span>处理进度</span>
              <span>{progress}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-200">
              <div
                className={`h-full rounded-full transition-all ${
                  progress === 100 ? 'bg-emerald-500' : 'bg-indigo-500'
                }`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Expanded detail */}
        {expanded && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            {report.summary}
          </div>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/governance/${report.id}`}>查看详情</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
            撤销
          </Button>
        </div>
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="撤销这次治理操作？"
          description="系统会按操作前快照恢复意图状态、权重和合并关系。"
          confirmLabel="撤销"
          loading={rollingBack}
          onConfirm={async () => {
            setRollingBack(true);
            try {
              await onRollback(report.id);
              setConfirmOpen(false);
            } finally {
              setRollingBack(false);
            }
          }}
        />
      </CardContent>
    </Card>
  );
}

export default function GovernancePage() {
  const { data, isLoading, error, mutate } = useApi<ApiResponse<GovernanceData>>('/api/v1/governance');

  async function rollbackGovernance(id: string) {
    const response = await fetch(withBasePath(`/api/v1/governance/${encodeURIComponent(id)}/rollback`), {
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error('治理回退失败');
    }
    await mutate();
  }

  if (isLoading) return <ListPageSkeleton rows={4} />;

  if (error) {
    return (
      <ErrorState
        title="治理报告加载失败"
        description={error.message || '暂时无法获取治理数据。'}
        onRetry={() => void mutate()}
      />
    );
  }

  const reports = data?.data?.reports ?? [];
  const stats = data?.data?.stats;

  if (reports.length === 0) {
    return (
      <EmptyState
        icon={Shield}
        title="暂无治理报告"
        description="系统会定期执行知识治理（过期检查、碎片聚合、自动清理），完成后报告会显示在这里。"
        primaryAction={{ label: '返回总览', href: '/dashboard' }}
      />
    );
  }

  // Estimate next governance run (based on cron schedule: daily 04:30)
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(4, 30, 0, 0);
  if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);
  const lastReport = reports[0];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">治理报告</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          知识库自动治理的执行记录。包括过期检查、碎片聚合和自动清理。
        </p>
      </div>

      {/* Stats header */}
      {stats && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">意图总数</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{stats.totalIntents}</p>
            </CardContent>
          </Card>
          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">活跃意图</p>
              <p className="mt-1 text-2xl font-semibold text-emerald-600">{stats.activeIntents}</p>
            </CardContent>
          </Card>
          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">待复核</p>
              <p className="mt-1 text-2xl font-semibold text-amber-600">{stats.pendingReview}</p>
            </CardContent>
          </Card>
          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">平均置信度</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">
                {Math.round(stats.avgConfidence * 100)}%
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Timeline info */}
      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-4 w-4" />
          最近治理：{lastReport ? formatDate(lastReport.createdAt) : '无'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <RefreshCw className="h-4 w-4" />
          下次预计：{nextRun.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* Reports list */}
      <div className="space-y-3">
        {reports.map((report) => (
          <ReportCard key={report.id} report={report} onRollback={rollbackGovernance} />
        ))}
      </div>
    </div>
  );
}
