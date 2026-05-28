'use client';

import { useMemo, useState } from 'react';
import { Brain, CheckCircle2, Plus, Search, ShieldAlert, Trash2 } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import type { ApiResponse } from '@/types';

interface IntentItem {
  id: string;
  name: string;
  description: string;
  positives: string[];
  negatives: string[];
  relatedEntryCount: number;
  recentHitCount: number;
  recentSnippets: { id: string; excerpt: string; hitAt: string }[];
  updateStatus: 'synced' | 'idle';
  updatedAt: string;
}

interface IntentData {
  items: IntentItem[];
}

function splitLines(value: string) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function IntentCard({ item, onDelete }: { item: IntentItem; onDelete: (id: string) => void }) {
  return (
    <Card className="border-2 border-rose-200 bg-white shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <Badge className="border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-50">意图知识</Badge>
            <CardTitle className="text-lg text-slate-950">{item.name}</CardTitle>
          </div>
          <button
            type="button"
            onClick={() => onDelete(item.id)}
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
            aria-label={`删除 ${item.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-6 text-slate-700">{item.description}</p>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4" />正例</div>
            {item.positives.length > 0 ? (
              <ul className="space-y-1 text-sm text-slate-700">
                {item.positives.map((line) => <li key={line}>· {line}</li>)}
              </ul>
            ) : <p className="text-sm text-slate-500">暂无正例</p>}
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-amber-700"><ShieldAlert className="h-4 w-4" />负例</div>
            {item.negatives.length > 0 ? (
              <ul className="space-y-1 text-sm text-slate-700">
                {item.negatives.map((line) => <li key={line}>· {line}</li>)}
              </ul>
            ) : <p className="text-sm text-slate-500">暂无负例</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>命中 {item.recentHitCount} 次</span>
          <span>更新 {item.updatedAt}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">独立 intents 表</span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function IntentPage() {
  const { data, isLoading, error, mutate } = useApi<ApiResponse<IntentData>>('/api/v1/intent/list');
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [positives, setPositives] = useState('');
  const [negatives, setNegatives] = useState('');
  const [saving, setSaving] = useState(false);

  const items = data?.data?.items ?? [];
  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    if (!kw) return items;
    return items.filter((item) => [item.name, item.description, ...item.positives, ...item.negatives].join(' ').toLowerCase().includes(kw));
  }, [items, query]);

  async function handleCreate() {
    if (!name.trim() || !description.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/v1/intent/create', {
        method: 'POST',
        body: JSON.stringify({ name, description, positives: splitLines(positives), negatives: splitLines(negatives) }),
      });
      setName('');
      setDescription('');
      setPositives('');
      setNegatives('');
      await mutate();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    await apiFetch(`/api/v1/intent?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    await mutate();
  }

  if (isLoading) return <ListPageSkeleton filters={2} rows={4} />;
  if (error) return <ErrorState title="意图库加载失败" description={error.message || '暂时拿不到意图知识'} onRetry={() => void mutate()} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-rose-700">
            <Brain className="h-5 w-5" />
            <span className="text-xs font-semibold uppercase tracking-[0.2em]">Intent Library</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">意图知识库</h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-600">意图知识独立存放、独立检索、独立卡片展示，不再混在领域 Wiki 或普通知识条目里。</p>
        </div>
      </div>

      <Card className="border-slate-200 bg-white shadow-sm">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="h-4 w-4" />新建意图</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="意图名称" />
          <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="意图描述" />
          <Textarea value={positives} onChange={(event) => setPositives(event.target.value)} placeholder="正例，每行一条" className="min-h-28" />
          <Textarea value={negatives} onChange={(event) => setNegatives(event.target.value)} placeholder="负例，每行一条" className="min-h-28" />
          <div className="md:col-span-2 flex justify-end">
            <Button onClick={handleCreate} disabled={saving || !name.trim() || !description.trim()}>{saving ? '保存中' : '保存意图'}</Button>
          </div>
        </CardContent>
      </Card>

      <div className="relative max-w-xl">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选意图名称、描述、正负例" className="pl-9" />
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Brain} title="暂无意图知识" description="先创建一条意图，后续消息注入会优先查询这里。" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {filtered.map((item) => <IntentCard key={item.id} item={item} onDelete={handleDelete} />)}
        </div>
      )}
    </div>
  );
}
