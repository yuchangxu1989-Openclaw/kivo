'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ChevronDown, ChevronRight, Database, Filter,
  Library, MoreHorizontal, Network, Search as SearchIcon, Upload,
} from 'lucide-react';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, sortableKeyboardCoordinates, useSortable,
  verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useApi } from '@/hooks/use-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { QuickCreateModal } from '@/components/quick-create-modal';
import { TagBadge } from '@/components/tag-badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/client-api';
import type { ApiResponse } from '@/types';
import { useCognitiveMode } from '@/contexts/cognitive-mode-context';
import { CognitivePanel } from '@/components/cognitive-panel';
import { TYPE_LABELS, typeLabel } from '@/lib/i18n-labels';

interface KnowledgeEntry {
  id: string;
  type: string;
  status: string;
  title?: string;
  content: string;
  domain?: string;
  createdAt: string;
  updatedAt: string;
  source?: { reference?: string; type?: string };
  metadata?: { tags?: string[]; domainData?: { sourceDocument?: string; sourceLocation?: string } };
  similarSentences?: string[] | string | null;
}

type ViewMode = 'list' | 'table' | 'board';
type ListDensity = 'compact' | 'comfortable' | 'spacious';
const SORT_ORDER_KEY = 'kivo-knowledge-custom-order';
const GROUP_COLLAPSED_KEY = 'kivo-group-collapsed';

const NATURE_KEYS = ['fact', 'decision', 'methodology'] as const;
const NATURE_LABELS: Record<string, string> = {
  fact: '事实', decision: '决策', methodology: '方法论',
};


const TYPE_COLORS: Record<string, string> = {
  fact: 'bg-blue-50 border-blue-200 text-blue-700',
  decision: 'bg-amber-50 border-amber-200 text-amber-700',
  methodology: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  experience: 'bg-purple-50 border-purple-200 text-purple-700',
  meta: 'bg-slate-100 border-slate-200 text-slate-600',
};
const TYPE_KEYS = ['fact', 'decision', 'methodology', 'experience', 'meta'];

function truncateText(text: string, maxLength = 30) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function extractTitle(content: string, explicitTitle?: string) {
  const t = explicitTitle?.trim() || content.trim();
  if (!t) return '未命名';
  const first = t.split('\n').find(l => l.trim().length > 0)?.trim() ?? t;
  return truncateText(first, 30);
}



function InlineCellSelect({
  value,
  options,
  labels,
  variant,
  onSave,
}: {
  value: string;
  options: string[];
  labels: Record<string, string>;
  variant?: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'>;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <Select
        value={value}
        onValueChange={(v) => { setEditing(false); if (v !== value) onSave(v); }}
        open
        onOpenChange={(open) => { if (!open) setEditing(false); }}
      >
        <SelectTrigger className="h-7 w-[100px] text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map(k => <SelectItem key={k} value={k}>{labels[k] ?? k}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }

  return (
    <button onClick={() => setEditing(true)} className="cursor-pointer">
      <Badge variant={variant?.[value] ?? 'secondary'} className="text-xs hover:ring-2 hover:ring-indigo-300 transition-shadow">
        {labels[value] ?? value}
      </Badge>
    </button>
  );
}

function TableView({ entries, sort, onSort, onPatch, selectedIds, onToggle }: { entries: KnowledgeEntry[]; sort: string; onSort: (s: string) => void; onPatch: (id: string, field: string, value: string) => void; selectedIds: Set<string>; onToggle: (id: string) => void }) {
  const cols = [
    { label: '', sortKey: '', responsive: '' },
    { label: '标题', sortKey: '', responsive: '' },
    { label: '内容', sortKey: '', responsive: '' },
    { label: '类型', sortKey: '', responsive: '' },
    { label: '知识域', sortKey: '', responsive: 'hidden md:table-cell' },
    { label: '创建', sortKey: '-createdAt', responsive: '' },
  ];
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white/95 shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50/80">
            {cols.map(c => (
              <th key={c.label} className={`px-4 py-3 text-left font-medium text-slate-600 ${c.responsive}`}>
                {c.sortKey ? (
                  <button className={`inline-flex items-center gap-1 hover:text-slate-900 ${sort === c.sortKey ? 'text-indigo-600' : ''}`} onClick={() => onSort(c.sortKey)}>
                    {c.label}{sort === c.sortKey && <span className="text-xs">↓</span>}
                  </button>
                ) : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map(e => (
            <tr key={e.id} className={`border-b border-slate-50 transition-colors hover:bg-slate-50/50 ${selectedIds.has(e.id) ? 'bg-indigo-50/50' : ''}`}>
              <td className="w-10 px-4 py-3">
                <input type="checkbox" checked={selectedIds.has(e.id)} onChange={() => onToggle(e.id)} className="h-4 w-4 rounded border-slate-300 accent-indigo-600 cursor-pointer" aria-label={`选择条目`} />
              </td>
              <td className="max-w-[160px] px-4 py-3">
                <Link href={`/knowledge/${e.id}`} title={(e.title || e.content).trim()} className="font-medium text-slate-800 hover:text-indigo-600 hover:underline truncate block">{extractTitle(e.content, e.title)}</Link>
              </td>
              <td className="max-w-[240px] px-4 py-3">
                <span className="text-xs text-slate-600 line-clamp-1">{e.content.length > 50 ? e.content.slice(0, 50) + '...' : e.content}</span>
              </td>
              <td className="px-4 py-3">
                <InlineCellSelect value={e.type} options={TYPE_KEYS} labels={TYPE_LABELS} onSave={(v) => onPatch(e.id, 'type', v)} />
              </td>
              <td className="px-4 py-3 text-xs text-muted-foreground hidden md:table-cell">{e.domain || '—'}</td>
              <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{new Date(e.createdAt).toLocaleDateString('zh-CN')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BoardView({ entries }: { entries: KnowledgeEntry[] }) {
  const grouped = useMemo(() => {
    const m: Record<string, KnowledgeEntry[]> = {};
    for (const k of TYPE_KEYS) m[k] = [];
    for (const e of entries) (m[e.type] ??= []).push(e);
    return m;
  }, [entries]);

  return (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {TYPE_KEYS.map(tk => (
        <div key={tk} className={`rounded-2xl border p-3 ${TYPE_COLORS[tk] ?? 'bg-slate-50 border-slate-200'}`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider">{TYPE_LABELS[tk] ?? tk}</span>
            <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs font-medium">{grouped[tk]?.length ?? 0}</span>
          </div>
          <div className="space-y-2">
            {(grouped[tk] ?? []).map(e => (
              <Link key={e.id} href={`/knowledge/${e.id}`} title={e.content.trim()} className="block rounded-xl bg-white/90 p-3 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
                <p className="text-xs font-medium text-slate-800 line-clamp-2">{extractTitle(e.content, e.title)}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  {e.domain && <span className="text-[10px] text-muted-foreground truncate">{e.domain}</span>}
                </div>
              </Link>
            ))}
            {(grouped[tk]?.length ?? 0) === 0 && <p className="py-4 text-center text-[10px] text-muted-foreground">暂无</p>}
          </div>
        </div>
      ))}
    </div>
  );
}
function getEntryTitle(entry: KnowledgeEntry) {
  return extractTitle(entry.content, entry.title);
}

function getEntrySummary(entry: KnowledgeEntry, density: ListDensity) {
  if (density === 'compact') return '';
  const content = entry.content.trim();
  if (density === 'comfortable') return content.length > 50 ? `${content.slice(0, 50)}…` : content;
  return content;
}

function getEntryDomain(entry: KnowledgeEntry) {
  return entry.domain?.trim() || '未分域';
}

function SortableListItem({ entry, density }: { entry: KnowledgeEntry; density: ListDensity }) {
  const { setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: 'relative' as const,
    zIndex: isDragging ? 10 : 'auto' as const,
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-stretch gap-0">
      <Link
        href={`/knowledge/${entry.id}`}
        title={entry.content.trim()}
        className={`block flex-1 rounded-2xl border border-slate-200 bg-white/95 shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:bg-accent ${density === 'compact' ? 'p-3' : 'p-4'}`}
      >
        <div className="flex items-start justify-between gap-2">
          <p className={`${density === 'compact' ? 'text-sm font-medium line-clamp-1' : 'text-sm font-medium line-clamp-2'} flex-1 text-slate-800`}>
            {getEntryTitle(entry)}
          </p>
          {density !== 'compact' && (
            <div className="flex gap-1 shrink-0">
              <Badge variant="secondary">{TYPE_LABELS[entry.type] ?? entry.type}</Badge>
              <Badge variant="outline">{entry.status === 'active' ? '活跃' : entry.status}</Badge>
            </div>
          )}
        </div>
        {density !== 'compact' && (
          <>
            <p className={`${density === 'comfortable' ? 'line-clamp-1' : 'whitespace-pre-wrap'} mt-2 text-sm leading-6 text-slate-600`}>
              {getEntrySummary(entry, density)}
            </p>
            <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
              {entry.domain && <span>域: {entry.domain}</span>}
              {(entry.metadata?.domainData?.sourceDocument || entry.source?.reference) && (
                <span className="text-slate-600">
                  来源: {entry.metadata?.domainData?.sourceDocument || entry.source?.reference}
                  {entry.metadata?.domainData?.sourceLocation && ` · ${entry.metadata.domainData.sourceLocation}`}
                </span>
              )}
              <span>{new Date(entry.updatedAt).toLocaleDateString('zh-CN')}</span>
            </div>
            {density === 'spacious' && (entry.metadata?.tags?.length ?? 0) > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {entry.metadata?.tags?.map(tag => <TagBadge key={tag} tag={tag} />)}
              </div>
            )}
          </>
        )}
      </Link>
    </div>
  );
}

function loadCustomOrder(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(SORT_ORDER_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveCustomOrder(order: Record<string, string[]>) {
  localStorage.setItem(SORT_ORDER_KEY, JSON.stringify(order));
}

function applyCustomOrder(items: KnowledgeEntry[], order: string[] | undefined): KnowledgeEntry[] {
  if (!order || order.length === 0) return items;
  const posMap = new Map(order.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const pa = posMap.get(a.id) ?? Infinity;
    const pb = posMap.get(b.id) ?? Infinity;
    return pa - pb;
  });
}

function loadGroupCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(GROUP_COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveGroupCollapsed(collapsed: Record<string, boolean>) {
  localStorage.setItem(GROUP_COLLAPSED_KEY, JSON.stringify(collapsed));
}

function CompactListView({ entries }: { entries: KnowledgeEntry[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="grid grid-cols-[92px_minmax(200px,1fr)_minmax(320px,2fr)_80px_104px] gap-3 border-b border-slate-200 px-4 py-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-600">
        <span>类型</span>
        <span>名称</span>
        <span>描述</span>
        <span>状态</span>
        <span>日期</span>
      </div>
      <div className="divide-y divide-cyan-300/10">
        {entries.map((entry) => (
          <Link
            key={entry.id}
            href={`/knowledge/${entry.id}`}
            className="grid grid-cols-[92px_minmax(200px,1fr)_minmax(320px,2fr)_80px_104px] items-start gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-slate-50"
          >
            <span>
              <Badge variant="secondary" className="max-w-full truncate">{TYPE_LABELS[entry.type] ?? entry.type}</Badge>
            </span>
            <span className="whitespace-normal break-words font-medium leading-6 text-slate-900" title={(entry.title || entry.content).trim()}>
              {getEntryTitle(entry)}
            </span>
            <span className="min-w-0">
              <span className="block line-clamp-2 text-slate-700" title={entry.content.trim()}>
                {entry.content.trim() || '—'}
              </span>
              {(entry.metadata?.domainData?.sourceDocument || (entry.source?.type === 'document' && entry.source?.reference)) && (
                <span className="block truncate text-xs text-slate-600 mt-0.5">
                  来源: {entry.metadata?.domainData?.sourceDocument || entry.source?.reference}
                  {entry.metadata?.domainData?.sourceLocation && ` · ${entry.metadata.domainData.sourceLocation}`}
                </span>
              )}
            </span>
            <span className="text-slate-600">{entry.status === 'active' ? '活跃' : entry.status}</span>
            <span className="whitespace-nowrap text-xs text-slate-500">{new Date(entry.updatedAt).toLocaleDateString('zh-CN')}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function GroupedListView({ entries, density }: { entries: KnowledgeEntry[]; density: ListDensity }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [customOrder, setCustomOrder] = useState<Record<string, string[]>>({});

  useEffect(() => {
    setCustomOrder(loadCustomOrder());
    setCollapsed(loadGroupCollapsed());
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const grouped = useMemo(() => {
    const m: Record<string, KnowledgeEntry[]> = {};
    for (const e of entries) (m[getEntryDomain(e)] ??= []).push(e);
    return Object.entries(m)
      .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
      .map(([domainName, items]) => [domainName, applyCustomOrder(items, customOrder[domainName])] as const);
  }, [entries, customOrder]);

  function toggleCollapsed(groupKey: string) {
    setCollapsed(prev => {
      const next = { ...prev, [groupKey]: !prev[groupKey] };
      saveGroupCollapsed(next);
      return next;
    });
  }

  function handleDragEnd(groupKey: string, event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const group = grouped.find(([tk]) => tk === groupKey);
    if (!group) return;
    const items = group[1];
    const oldIndex = items.findIndex(e => e.id === active.id);
    const newIndex = items.findIndex(e => e.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(items.map(e => e.id), oldIndex, newIndex);
    const next = { ...customOrder, [groupKey]: reordered };
    setCustomOrder(next);
    saveCustomOrder(next);
  }

  return (
    <div className="space-y-4">
      {grouped.map(([tk, items]) => (
        <div key={tk}>
          <button className="mb-2 flex w-full items-center gap-2 rounded-xl px-2 py-1 text-left hover:bg-slate-100" onClick={() => toggleCollapsed(tk)}>
            {collapsed[tk] ? <ChevronRight className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
            <span className="text-sm font-semibold text-slate-700">{tk}</span>
            <span className="text-xs text-muted-foreground">({items.length})</span>
          </button>
          {!collapsed[tk] && (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => handleDragEnd(tk, e)}>
              <SortableContext items={items.map(e => e.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2 pl-6">
                  {items.map(e => <SortableListItem key={e.id} entry={e} density={density} />)}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      ))}
    </div>
  );
}



function KnowledgeListPageInner() {
  const searchParams = useSearchParams();
  const [viewMode] = useState<ViewMode>('list');
  const [density] = useState<ListDensity>('comfortable');
  const [type, setType] = useState(searchParams.get('type') ?? '');
  const [nature, setNature] = useState(searchParams.get('nature') ?? '');
  const [domain, setDomain] = useState(searchParams.get('domain') ?? '');
  const [source, setSource] = useState(searchParams.get('source') ?? '');
  const [quickSearch, setQuickSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('-updatedAt');
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const { isFocus } = useCognitiveMode();
  const [tagFilter, setTagFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showMore, setShowMore] = useState(false);


  const params = new URLSearchParams();
  if (nature) params.set('type', nature);
  else if (type) params.set('type', type);
  else params.set('excludeTypes', 'wiki_page,wiki_space,intent');
  params.set('status', 'active');
  if (domain.trim()) params.set('domain', domain.trim());
  if (source.trim()) params.set('source', source.trim());
  params.set('page', String(page));
  params.set('pageSize', '24');
  params.set('sort', sort);

  const { data, isLoading, error, mutate } = useApi<ApiResponse<KnowledgeEntry[]>>(`/api/v1/knowledge?${params.toString()}`);
  const entries = data?.data ?? [];
  const meta = data?.meta;

  // P1-2: Retry count for degradation after 3 failures
  const [retryCount, setRetryCount] = useState(0);

  const handleRetry = useCallback(() => {
    if (retryCount >= 3) return;
    setRetryCount(prev => prev + 1);
    mutate().catch(() => {
      if (retryCount + 1 >= 3) {
        console.error('[KIVO] 重试 3 次仍失败，建议用户刷新页面');
      }
    });
  }, [retryCount, mutate]);



  const filteredEntries = useMemo(() => {
    let result = entries;
    if (tagFilter) {
      result = result.filter(e => (e.metadata?.tags ?? []).includes(tagFilter));
    }
    const kw = quickSearch.trim().toLowerCase();
    if (kw) {
      result = result.filter(e => [e.content, e.domain, e.source?.reference, e.type, e.status, ...(e.metadata?.tags ?? [])].filter(Boolean).join(' ').toLowerCase().includes(kw));
    }
    return result;
  }, [entries, quickSearch, tagFilter]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      for (const t of e.metadata?.tags ?? []) set.add(t);
    }
    return Array.from(set).sort();
  }, [entries]);

  useEffect(() => {
    function handleKnowledgeCreated() {
      void mutate();
    }

    window.addEventListener('kivo:knowledge-created', handleKnowledgeCreated);
    return () => window.removeEventListener('kivo:knowledge-created', handleKnowledgeCreated);
  }, [mutate]);

  const handlePatch = useCallback(async (id: string, field: string, value: string) => {
    await apiFetch(`/api/v1/knowledge/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    });
    void mutate();
  }, [mutate]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const allSelected = filteredEntries.length > 0 && filteredEntries.every(e => selectedIds.has(e.id));

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredEntries.map(e => e.id)));
    }
  }, [allSelected, filteredEntries]);

  if (isLoading) return <ListPageSkeleton filters={5} rows={5} />;
  if (error) {
    if (retryCount >= 3) {
      return (
        <ErrorState
          title="多次重试仍然失败"
          description="请刷新页面后重试。如果问题持续，请联系管理员。"
        />
      );
    }
    return <ErrorState title="知识条目加载失败" description={error.message || '暂时拿不到知识列表，请稍后重试。'} onRetry={handleRetry} retryLabel={`重新加载 (${retryCount}/3)`} />;
  }

  return (
    <div className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">知识库</h1>
            <p className="max-w-3xl text-sm leading-6 text-slate-600">
              {meta?.total != null ? `共 ${meta.total} 条活跃知识。列表、筛选、导入都收在这一个入口。` : '加载中...'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:justify-end">
            <QuickCreateModal
              open={quickCreateOpen}
              onOpenChange={setQuickCreateOpen}
              onCreated={() => void mutate()}
              triggerLabel="新建知识"
            />
            <Link href="/knowledge/import" className="inline-flex h-10 items-center gap-2 rounded-xl bg-cyan-500 px-4 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-400">
              <Upload className="h-4 w-4" />
              导入
            </Link>
            <Link href="/graph" className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50">
              <Network className="h-4 w-4" />
              图谱视图
            </Link>
            <div className="relative">
              <button type="button" onClick={() => setShowMore((v) => !v)} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900">
                <MoreHorizontal className="h-4 w-4" />
                更多操作
              </button>
              {showMore && (
                <div className="absolute right-0 z-20 mt-2 w-56 rounded-2xl border border-slate-200 bg-white p-2 text-sm shadow-xl backdrop-blur-xl">
                  <button className="block w-full rounded-xl px-3 py-2 text-left text-slate-700 hover:bg-slate-50" onClick={toggleSelectAll}>
                    {selectedIds.size > 0 ? `已选 ${selectedIds.size} 条` : '批量选择'}
                  </button>
                  <Link href="/knowledge/import" className="block rounded-xl px-3 py-2 text-slate-700 hover:bg-slate-50">导入历史</Link>
                </div>
              )}
            </div>
          </div>
        </div>

      <CognitivePanel visible={!isFocus}>
      <Card className="border-slate-200 bg-white shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2 text-indigo-600">
            <Filter className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-[0.2em]">筛选</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
            <div className="relative sm:col-span-1">
              <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <Input className="pl-9" value={quickSearch} onChange={e => setQuickSearch(e.target.value)} placeholder="搜索标题、内容、标签" aria-label="即时搜索" />
            </div>
            <Select value={type || 'all-types'} onValueChange={v => { setType(v === 'all-types' ? '' : v); setPage(1); }}>
              <SelectTrigger className="w-full" aria-label="按知识类型筛选"><SelectValue placeholder="全部类型" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all-types">全部类型</SelectItem>
                {TYPE_KEYS.map(k => <SelectItem key={k} value={k}>{TYPE_LABELS[k]}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value="active" onValueChange={() => undefined}>
              <SelectTrigger className="w-full" aria-label="按状态筛选"><SelectValue placeholder="活跃" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">活跃</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
      </CognitivePanel>

      {filteredEntries.length === 0 ? (
        <EmptyState
          icon={Library}
          title="当前筛选条件下没有知识条目"
          description="试试放宽筛选条件，或者先去搜索页确认有没有相关知识。"
          primaryAction={{ label: '去语义搜索', href: '/search' }}
          secondaryAction={{ label: '清空筛选', onClick: () => { setType(''); setNature(''); setDomain(''); setSource(''); setTagFilter(''); setQuickSearch(''); setSort('-updatedAt'); setPage(1); }, variant: 'outline' }}
        />
      ) : (
        <>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-600">默认列表展示类型、名称、描述、状态和日期。</p>
          </div>
          {viewMode === 'table' && <TableView entries={filteredEntries} sort={sort} onSort={setSort} onPatch={handlePatch} selectedIds={selectedIds} onToggle={toggleSelect} />}
          {viewMode === 'board' && <BoardView entries={filteredEntries} />}
          {viewMode === 'list' && <CompactListView entries={filteredEntries} />}
        </>
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
    </div>
  );
}

export default function KnowledgeListPage() {
  return (
    <Suspense fallback={<ListPageSkeleton filters={5} rows={5} />}>
      <KnowledgeListPageInner />
    </Suspense>
  );
}