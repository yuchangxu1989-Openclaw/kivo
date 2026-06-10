'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Brain, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
  createdAt?: string;
  updatedAt: string;
}

interface IntentData {
  items: IntentItem[];
}

type SortMode = 'updatedAt' | 'createdAt';

interface CreateIntentDraft {
  name: string;
  description: string;
  why: string;
  similarSentences: string;
}

const EMPTY_DRAFT: CreateIntentDraft = {
  name: '',
  description: '',
  why: '',
  similarSentences: '',
};

function normalizeContent(value: string | undefined) {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '')
    .trim();
}

function normalizeSentence(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function splitSimilarSentences(value: string) {
  return value
    .split('\n')
    .map(normalizeSentence)
    .filter(Boolean);
}

function firstReadableClause(value: string) {
  const text = normalizeSentence(value);
  if (!text) return '';
  const clauses = text
    .split(/[。！？!?；;：:，,、|/\\()[\]{}"'“”‘’]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
  return clauses.find((part) => part.length <= 24) ?? text;
}

function getDisplayTitle(item: IntentItem) {
  const titleParts = normalizeSentence(item.name)
    .split(/[：:]/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
  const specificTitle = [...titleParts].reverse().find((part) => part.length <= 24);
  if (specificTitle) return specificTitle;
  const fromName = firstReadableClause(item.name);
  if (fromName && fromName.length <= 24) return fromName;
  const fromDescription = firstReadableClause(item.description);
  if (fromDescription && fromDescription.length <= 24) return fromDescription;
  return normalizeSentence(item.name);
}

function summarizeText(value: string | undefined) {
  const text = normalizeSentence(value ?? '');
  if (!text) return '';
  const firstClause = firstReadableClause(text);
  if (firstClause && firstClause.length <= 72) return firstClause;
  const sentence = text.match(/^.{1,72}(?:[。！？!?；;，,]|$)/u)?.[0]?.trim();
  return sentence || text;
}

function timestamp(value: string | undefined) {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function getIntentSignature(item: IntentItem) {
  const name = normalizeContent(item.name);
  const description = normalizeContent(item.description);
  const why = normalizeContent(item.why);
  return [name, description, why].filter(Boolean).join('|');
}

function dedupeIntentItems(items: IntentItem[]) {
  const byId = new Map<string, IntentItem>();
  const byContent = new Map<string, IntentItem>();

  for (const item of items) {
    const existingById = byId.get(item.id);
    const selectedById = chooseLatest(existingById, item);
    byId.set(item.id, selectedById);
  }

  for (const item of byId.values()) {
    const signature = getIntentSignature(item);
    if (!signature) continue;
    const existing = byContent.get(signature);
    byContent.set(signature, chooseLatest(existing, item));
  }

  const signedIds = new Set([...byContent.values()].map((item) => item.id));
  const unsigned = [...byId.values()].filter((item) => !getIntentSignature(item) && !signedIds.has(item.id));
  return [...byContent.values(), ...unsigned];
}

function chooseLatest(current: IntentItem | undefined, next: IntentItem) {
  if (!current) return next;
  const currentTime = Math.max(timestamp(current.updatedAt), timestamp(current.createdAt));
  const nextTime = Math.max(timestamp(next.updatedAt), timestamp(next.createdAt));
  return nextTime >= currentTime ? next : current;
}

function IntentList({ items, onNavigate, onDelete }: { items: IntentItem[]; onNavigate: (id: string) => void; onDelete: (item: IntentItem) => void }) {
  return (
    <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white shadow-sm">
      {items.map((item) => (
        <IntentListItem key={item.id} item={item} onNavigate={onNavigate} onDelete={onDelete} />
      ))}
    </div>
  );
}

function IntentListItem({ item, onNavigate, onDelete }: { item: IntentItem; onNavigate: (id: string) => void; onDelete: (item: IntentItem) => void }) {
  const displayTitle = getDisplayTitle(item);
  const descriptionSummary = summarizeText(item.description);
  const whySummary = summarizeText(item.why);
  const fullWhy = item.why?.trim() || '暂无 why';

  return (
    <article
      role="link"
      tabIndex={0}
      aria-label={`打开意图 ${displayTitle}`}
      onClick={() => onNavigate(item.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onNavigate(item.id);
        }
      }}
      className="grid cursor-pointer gap-3 px-4 py-4 text-slate-950 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50 md:grid-cols-[minmax(9rem,0.9fr)_minmax(14rem,1.35fr)_minmax(14rem,1.35fr)_9.5rem_auto] md:items-start"
    >
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">名称</p>
        <p className="mt-1 break-words text-sm font-semibold leading-5 text-slate-950" title={item.name.trim()}>
          {displayTitle}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">描述摘要</p>
        <p className="mt-1 break-words text-sm leading-5 text-slate-700" title={item.description.trim()}>
          {descriptionSummary || '暂无描述'}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">why</p>
        <p className="mt-1 break-words text-sm leading-5 text-slate-700" title={fullWhy}>
          {whySummary || <span className="text-slate-500">暂无 why</span>}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">更新时间</p>
        <p className="mt-1 whitespace-nowrap text-sm leading-5 text-slate-700" title={item.updatedAt}>
          {item.updatedAt || '暂无记录'}
        </p>
      </div>
      <div className="flex justify-start md:justify-end">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(item);
          }}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
          aria-label={`删除 ${displayTitle}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </article>
  );
}

export default function IntentPage() {
  const router = useRouter();
  const { data, isLoading, error, mutate } = useApi<ApiResponse<IntentData>>('/api/v1/intent/list');
  const [query, setQuery] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [draft, setDraft] = useState<CreateIntentDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<IntentItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const [sortMode, setSortMode] = useState<SortMode>('updatedAt');

  const items = data?.data?.items ?? [];
  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    const visibleItems = dedupeIntentItems(items).filter((item) => !deletedIds.has(item.id));
    const filteredItems = kw
      ? visibleItems.filter((item) => [item.name, item.description, item.why ?? ''].join(' ').toLowerCase().includes(kw))
      : visibleItems;
    return [...filteredItems].sort((a, b) => timestamp(b[sortMode]) - timestamp(a[sortMode]));
  }, [deletedIds, items, query, sortMode]);

  async function handleCreate() {
    if (!draft.name.trim() || !draft.description.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/v1/intent/create', {
        method: 'POST',
        body: JSON.stringify({
          name: draft.name.trim(),
          description: draft.description.trim(),
          why: draft.why.trim(),
          similarSentences: splitSimilarSentences(draft.similarSentences),
        }),
      });
      setDraft(EMPTY_DRAFT);
      setCreateDialogOpen(false);
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
    const deleteTarget = pendingDelete;
    setDeleting(true);
    try {
      await apiFetch(`/api/v1/intent?id=${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' });
      setDeletedIds((current) => new Set([...current, deleteTarget.id]));
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
          <p className="max-w-3xl text-sm leading-6 text-slate-600">意图知识独立存放、独立检索，以列表扫读名称、描述摘要、why 和更新时间。</p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)} className="inline-flex items-center gap-2 bg-slate-950 text-white hover:bg-slate-800">
          <Plus className="h-4 w-4" />
          新建意图
        </Button>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm md:flex-row md:items-center md:justify-between">
        <div className="relative w-full md:max-w-xl">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选意图名称、描述、why" className="bg-white pl-9 text-slate-950" aria-label="筛选意图" />
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <span>排序</span>
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as SortMode)}
            className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-950 outline-none transition-colors focus:border-slate-400"
            aria-label="意图排序"
          >
            <option value="updatedAt">按更新时间</option>
            <option value="createdAt">按创建时间</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Brain} title="暂无意图知识" description="先创建一条意图，后续消息注入会优先查询这里。" />
      ) : (
        <IntentList
          items={filtered}
          onNavigate={(id) => router.push(`/intent/${id}`)}
          onDelete={setPendingDelete}
        />
      )}

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto bg-white text-slate-950 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>新建意图</DialogTitle>
            <DialogDescription>录入名称、描述、why 和相似句，提交后刷新列表。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <label htmlFor="intent-name" className="text-sm font-medium text-slate-800">名称</label>
              <Input
                id="intent-name"
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="意图名称"
                className="bg-white text-slate-950"
              />
            </div>
            <div className="grid gap-2">
              <label htmlFor="intent-description" className="text-sm font-medium text-slate-800">描述</label>
              <Textarea
                id="intent-description"
                value={draft.description}
                onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                placeholder="意图描述"
                className="min-h-24 bg-white text-slate-950"
              />
            </div>
            <div className="grid gap-2">
              <label htmlFor="intent-why" className="text-sm font-medium text-slate-800">why</label>
              <Textarea
                id="intent-why"
                value={draft.why}
                onChange={(event) => setDraft((current) => ({ ...current, why: event.target.value }))}
                placeholder="说明为什么需要记录这个意图"
                className="min-h-24 bg-white text-slate-950"
              />
            </div>
            <div className="grid gap-2">
              <label htmlFor="intent-similar" className="text-sm font-medium text-slate-800">相似句</label>
              <Textarea
                id="intent-similar"
                value={draft.similarSentences}
                onChange={(event) => setDraft((current) => ({ ...current, similarSentences: event.target.value }))}
                placeholder="每行一条"
                className="min-h-24 bg-white text-slate-950"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateDialogOpen(false);
                setDraft(EMPTY_DRAFT);
              }}
            >
              取消
            </Button>
            <Button onClick={() => void handleCreate()} disabled={saving || !draft.name.trim() || !draft.description.trim()} className="bg-slate-950 text-white hover:bg-slate-800">
              {saving ? '保存中' : '保存意图'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        title="确认删除"
        description={pendingDelete ? `此操作将永久删除意图「${getDisplayTitle(pendingDelete)}」，不可撤销。` : ''}
        confirmLabel="确认删除"
        variant="destructive"
        loading={deleting}
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  );
}
