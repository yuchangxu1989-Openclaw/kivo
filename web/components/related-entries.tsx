'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Link2, Plus, Search as SearchIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { typeLabel } from '@/lib/i18n-labels';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import type { ApiResponse } from '@/types';

interface Relation {
  type: string;
  targetId: string;
  targetContent?: string;
}

interface RelatedEntriesProps {
  entryId: string;
  relations: Relation[];
  onRelationAdded?: () => void;
}

const RELATION_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  related: { label: '相关', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
  references: { label: '引用', color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
  contradicts: { label: '矛盾', color: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' },
  supports: { label: '支持', color: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' },
  depends_on: { label: '依赖', color: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300' },
  co_occurs: { label: '共现', color: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300' },
};

function RelationTypeBadge({ type }: { type: string }) {
  const config = RELATION_TYPE_LABELS[type];
  if (!config) return <Badge variant="outline">{type}</Badge>;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${config.color}`}>
      {config.label}
    </span>
  );
}

interface SearchEntry {
  id: string;
  content: string;
  type: string;
}

function AddRelationDialog({ entryId, onAdded }: { entryId: string; onAdded?: () => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedType, setSelectedType] = useState('related');
  const [saving, setSaving] = useState(false);

  const { data } = useApi<ApiResponse<SearchEntry[]>>(
    open ? '/api/v1/knowledge' : null
  );
  const allCandidates = data?.data ?? [];
  const candidates = useMemo(
    () =>
      allCandidates.filter(
        (e) => e.id !== entryId && e.content.toLowerCase().includes(query.toLowerCase())
      ),
    [allCandidates, entryId, query]
  );

  async function handleAdd(targetId: string) {
    setSaving(true);
    try {
      await apiFetch(`/api/v1/knowledge/${entryId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          addRelation: { type: selectedType, targetId },
        }),
      });
      onAdded?.();
      setOpen(false);
      setQuery('');
    } finally {
      setSaving(false);
    }
  }

  function extractTitle(content: string) {
    const trimmed = content.trim();
    if (!trimmed) return '未命名';
    const first = trimmed.split('\n').find((l) => l.trim()) ?? trimmed;
    return first.length > 50 ? `${first.slice(0, 50)}...` : first;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          添加关联
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加关联知识</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <select
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              aria-label="关联类型"
            >
              {Object.entries(RELATION_TYPE_LABELS).map(([key, { label }]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <div className="relative flex-1">
              <SearchIcon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="搜索知识条目…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
                aria-label="搜索知识条目"
              />
            </div>
          </div>
          <ul className="max-h-60 space-y-1 overflow-y-auto">
            {candidates.slice(0, 20).map((entry) => (
              <li key={entry.id}>
                <button
                  className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                  disabled={saving}
                  onClick={() => void handleAdd(entry.id)}
                >
                  <span className="font-medium">{extractTitle(entry.content)}</span>
                  <Badge variant="secondary" className="ml-2 text-[10px]">{typeLabel(entry.type)}</Badge>
                </button>
              </li>
            ))}
            {candidates.length === 0 && (
              <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                {query ? '没有匹配的条目' : '暂无可关联的条目'}
              </li>
            )}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RelatedEntries({ entryId, relations, onRelationAdded }: RelatedEntriesProps) {
  return (
    <Card className="border-slate-200/80 bg-white/95 shadow-sm dark:border-slate-700/60 dark:bg-slate-900/95">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Link2 className="h-4.5 w-4.5 text-muted-foreground" />
            关联知识
            {relations.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground">({relations.length})</span>
            )}
          </CardTitle>
          <AddRelationDialog entryId={entryId} onAdded={onRelationAdded} />
        </div>
      </CardHeader>
      <CardContent>
        {relations.length === 0 ? (
          <p className="py-3 text-center text-sm text-muted-foreground">暂无关联知识</p>
        ) : (
          <ul className="space-y-2">
            {relations.map((rel, i) => (
              <li key={`${rel.targetId}-${i}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <RelationTypeBadge type={rel.type} />
                <Link
                  href={`/knowledge/${rel.targetId}`}
                  className="line-clamp-1 flex-1 text-sm text-primary hover:underline"
                >
                  {rel.targetContent || rel.targetId}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
