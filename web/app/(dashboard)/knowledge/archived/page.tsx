'use client';

import Link from 'next/link';
import { Suspense, useCallback, useMemo, useState } from 'react';
import { Archive, ArrowLeft, Database, Search as SearchIcon } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import { apiFetch } from '@/lib/client-api';
import { BatchActionBar } from '@/components/batch-action-bar';
import type { ApiResponse } from '@/types';
import { TYPE_LABELS } from '@/lib/i18n-labels';

interface KnowledgeEntry {
  id: string;
  type: string;
  status: string;
  content: string;
  domain?: string;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
  source?: { reference?: string };
  metadata?: { tags?: string[] };
}

function extractTitle(content: string) {
  const t = content.trim();
  if (!t) return '未命名';
  const first = t.split('\n').find(l => l.trim().length > 0) ?? t;
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

function ArchivedPageInner() {
  const [page, setPage] = useState(1);
  const [quickSearch, setQuickSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const params = new URLSearchParams();
  params.set('status', 'archived');
  params.set('page', String(page));
  params.set('pageSize', '24');
  params.set('sort', '-updatedAt');

  const { data, isLoading, error, mutate } = useApi<ApiResponse<KnowledgeEntry[]>>(`/api/v1/knowledge?${params.toString()}`);
  const entries = data?.data ?? [];
  const meta = data?.meta;

  const filteredEntries = useMemo(() => {
    const kw = quickSearch.trim().toLowerCase();
    if (!kw) return entries;
    return entries.filter(e =>
      [e.content, e.domain, e.type, ...(e.metadata?.tags ?? [])].filter(Boolean).join(' ').toLowerCase().includes(kw)
    );
  }, [entries, quickSearch]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleRestore = useCallback(async (id: string) => {
    await apiFetch(`/api/v1/knowledge/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
    });
    void mutate();
  }, [mutate]);

  if (isLoading) return <ListPageSkeleton filters={1} rows={5} />;
  if (error) return <ErrorState title="归档知识加载失败" description={error.message || '暂时拿不到归档列表，请稍后重试。'} onRetry={() => void mutate()} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <Link
              href="/knowledge"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              返回知识库
            </Link>
          </div>
          <div className="flex items-center gap-2.5">
            <Archive className="h-5 w-5 text-slate-400" />
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">归档知识</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            已归档的知识条目。可以恢复到活跃状态。
          </p>
        </div>
      </div>

      <div className="relative max-w-md">
        <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          value={quickSearch}
          onChange={e => setQuickSearch(e.target.value)}
          placeholder="搜索归档知识"
          aria-label="搜索归档知识"
        />
      </div>

      {filteredEntries.length === 0 ? (
        <EmptyState
          icon={Archive}
          title="没有归档的知识条目"
          description="归档的知识条目会显示在这里。"
          primaryAction={{ label: '返回知识库', href: '/knowledge' }}
        />
      ) : (
        <div className="space-y-2">
          {filteredEntries.map(entry => (
            <div
              key={entry.id}
              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white/95 p-4 shadow-sm transition-all hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800/95 dark:hover:border-slate-600"
            >
              <input
                type="checkbox"
                checked={selectedIds.has(entry.id)}
                onChange={() => toggleSelect(entry.id)}
                className="h-4 w-4 shrink-0 rounded border-slate-300 accent-indigo-600 cursor-pointer"
                aria-label="选择条目"
              />
              <Link
                href={`/knowledge/${entry.id}`}
                title={entry.content.trim()}
                className="flex-1 min-w-0"
              >
                <p className="text-sm font-medium text-slate-800 hover:text-indigo-600 dark:text-slate-200 dark:hover:text-indigo-400 truncate">
                  {extractTitle(entry.content)}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary" className="text-[10px]">{TYPE_LABELS[entry.type] ?? entry.type}</Badge>
                  {entry.domain && <span>{entry.domain}</span>}
                  <span>{new Date(entry.updatedAt).toLocaleDateString('zh-CN')}</span>
                </div>
              </Link>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 text-xs"
                onClick={() => handleRestore(entry.id)}
              >
                恢复
              </Button>
            </div>
          ))}
        </div>
      )}

      {meta && (
        <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Database className="h-4 w-4" />共 {meta.total} 条 · 第 {meta.page} / {meta.totalPages ?? Math.max(1, Math.ceil(meta.total / meta.pageSize))} 页
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</Button>
            <Button variant="outline" size="sm" disabled={page >= (meta.totalPages ?? Math.max(1, Math.ceil(meta.total / meta.pageSize)))} onClick={() => setPage(p => p + 1)}>下一页</Button>
          </div>
        </div>
      )}

      <BatchActionBar
        selectedIds={selectedIds}
        onClear={() => setSelectedIds(new Set())}
        onDeleted={() => { setSelectedIds(new Set()); void mutate(); }}
      />
    </div>
  );
}

export default function ArchivedKnowledgePage() {
  return (
    <Suspense fallback={<ListPageSkeleton filters={1} rows={5} />}>
      <ArchivedPageInner />
    </Suspense>
  );
}
