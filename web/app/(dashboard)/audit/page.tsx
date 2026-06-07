'use client';

import { useState } from 'react';
import { CalendarClock, FileText, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import { useApi } from '@/hooks/use-api';
import type { ApiResponse } from '@/types';

type AuditEventType = 'all' | 'knowledge_change' | 'document_import' | 'research_complete' | 'governance_run' | 'vectorization_batch';

interface AuditEntry {
  id: string;
  action: string;
  title: string;
  detail: string;
  actor: string;
  targetType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

const FILTERS: { key: AuditEventType; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'knowledge_change', label: '知识生命周期' },
  { key: 'document_import', label: '文档导入' },
  { key: 'research_complete', label: '调研完成' },
  { key: 'governance_run', label: '治理运行' },
  { key: 'vectorization_batch', label: '向量化' },
];

const ACTION_LABELS: Record<string, string> = {
  'knowledge:lifecycle': '知识生命周期',
  'document:import': '文档导入',
  'research:complete': '调研完成',
  'governance:run': '治理运行',
  'vectorization:batch': '向量化批次',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function metadataSummary(metadata: Record<string, unknown>): string {
  const entries = Object.entries(metadata)
    .filter(([key, value]) => !['actor', 'targetType'].includes(key) && value !== null && value !== undefined)
    .slice(0, 3);
  if (entries.length === 0) return '无附加字段';
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(' · ');
}

function AuditEntryRow({ entry }: { entry: AuditEntry }) {
  return (
    <Card className="border-slate-200 bg-white shadow-sm">
      <CardContent className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="border-slate-300 text-slate-800">
                {ACTION_LABELS[entry.action] ?? entry.action}
              </Badge>
              <h2 className="truncate text-sm font-semibold text-slate-950">{entry.title}</h2>
            </div>
            {entry.detail && <p className="text-sm leading-6 text-slate-700">{entry.detail}</p>}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1">
                <UserRound className="h-3.5 w-3.5" />
                {entry.actor}
              </span>
              <span className="inline-flex items-center gap-1">
                <FileText className="h-3.5 w-3.5" />
                {entry.targetType}
              </span>
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="h-3.5 w-3.5" />
                {formatDate(entry.createdAt)}
              </span>
            </div>
          </div>
          <p className="max-w-full text-xs text-slate-500 sm:max-w-xs sm:text-right">
            {metadataSummary(entry.metadata)}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AuditPage() {
  const [filter, setFilter] = useState<AuditEventType>('all');
  const query = filter === 'all' ? '/api/v1/audit?limit=100' : `/api/v1/audit?limit=100&eventType=${filter}`;
  const { data, isLoading, error, mutate } = useApi<ApiResponse<AuditEntry[]>>(query);
  const entries = data?.data ?? [];
  const total = data?.meta?.total ?? entries.length;

  if (isLoading && entries.length === 0) return <ListPageSkeleton rows={5} />;

  if (error && entries.length === 0) {
    return (
      <ErrorState
        title="审计条目加载失败"
        description={error.message || '暂时无法读取审计记录。'}
        onRetry={() => void mutate()}
      />
    );
  }

  return (
    <div className="space-y-6 bg-white text-slate-950">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">操作审计</h1>
          <p className="text-sm text-slate-600">知识生命周期与系统关键动作的审计记录 · 共 {total} 条</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void mutate()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          刷新
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            onClick={() => setFilter(item.key)}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
              filter === item.key
                ? 'border-slate-950 bg-slate-950 text-white'
                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="暂无审计条目"
          description="系统产生知识生命周期、治理、导入或向量化记录后，会在这里显示。"
        />
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => <AuditEntryRow key={entry.id} entry={entry} />)}
        </div>
      )}
    </div>
  );
}
