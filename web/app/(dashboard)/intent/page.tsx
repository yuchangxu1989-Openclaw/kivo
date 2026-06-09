'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Brain, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import type { ApiResponse } from '@/types';

interface IntentItem {
  id: string;
  name: string;
  description: string;
  why?: string;
  similarSentences: string[];
  relatedEntryCount: number;
  recentHitCount: number;
  recentSnippets: { id: string; excerpt: string; hitAt: string }[];
  updateStatus: 'synced' | 'idle';
  updatedAt: string;
}

interface IntentData {
  items: IntentItem[];
}

function IntentRow({ item, onNavigate, onDelete }: { item: IntentItem; onNavigate: (id: string) => void; onDelete: (item: IntentItem) => void }) {
  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={() => onNavigate(item.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onNavigate(item.id);
        }
      }}
      className="cursor-pointer border-b border-slate-100 transition-colors hover:bg-rose-50/40 focus:outline-none focus-visible:bg-rose-50/60"
    >
      <td className="max-w-[200px] px-4 py-3">
        <span className="block truncate font-medium text-slate-900" title={item.name}>{item.name}</span>
      </td>
      <td className="max-w-[320px] px-4 py-3">
        <span className="block truncate text-sm text-slate-600" title={item.description}>{item.description}</span>
      </td>
      <td className="max-w-[320px] px-4 py-3">
        <span className="block truncate text-sm text-slate-600" title={item.why?.trim() || ''}>{item.why?.trim() || '—'}</span>
      </td>
      <td className="hidden whitespace-nowrap px-4 py-3 text-sm text-slate-500 lg:table-cell">{item.updatedAt}</td>
      <td className="w-12 px-4 py-3 text-right">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(item);
          }}
          className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
          aria-label={`删除 ${item.name}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </td>
    </tr>
  );
}

function IntentTable({ items, onNavigate, onDelete }: { items: IntentItem[]; onNavigate: (id: string) => void; onDelete: (item: IntentItem) => void }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-xs font-medium text-slate-600">
            <th className="px-4 py-3">名称</th>
            <th className="px-4 py-3">描述</th>
            <th className="px-4 py-3">why</th>
            <th className="hidden px-4 py-3 lg:table-cell">更新时间</th>
            <th className="w-12 px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <IntentRow key={item.id} item={item} onNavigate={onNavigate} onDelete={onDelete} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function IntentPage() {
  const router = useRouter();
  const { data, isLoading, error, mutate } = useApi<ApiResponse<IntentData>>('/api/v1/intent/list');
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [why, setWhy] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<IntentItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const items = data?.data?.items ?? [];
  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    if (!kw) return items;
    return items.filter((item) => [item.name, item.description, item.why ?? ''].join(' ').toLowerCase().includes(kw));
  }, [items, query]);

  async function handleCreate() {
    if (!name.trim() || !description.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/v1/intent/create', {
        method: 'POST',
        body: JSON.stringify({ name, description, why: why.trim() }),
      });
      setName('');
      setDescription('');
      setWhy('');
      await mutate();
      toast.success('意图已保存');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/v1/intent?id=${encodeURIComponent(pendingDelete.id)}`, { method: 'DELETE' });
      await mutate();
      toast.success('意图已删除');
      setPendingDelete(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
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
          <Textarea value={why} onChange={(event) => setWhy(event.target.value)} placeholder="说明为什么需要记录这个意图" className="min-h-28 md:col-span-2" />
          <div className="md:col-span-2 flex justify-end">
            <Button onClick={handleCreate} disabled={saving || !name.trim() || !description.trim()}>{saving ? '保存中' : '保存意图'}</Button>
          </div>
        </CardContent>
      </Card>

      <div className="relative max-w-xl">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选意图名称、描述、why" className="pl-9" />
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Brain} title="暂无意图知识" description="先创建一条意图，后续消息注入会优先查询这里。" />
      ) : (
        <IntentTable
          items={filtered}
          onNavigate={(id) => router.push(`/intent/${id}`)}
          onDelete={setPendingDelete}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        title="确认删除"
        description={pendingDelete ? `此操作将永久删除意图「${pendingDelete.name}」，不可撤销。` : ''}
        confirmLabel="确认删除"
        variant="destructive"
        loading={deleting}
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  );
}
