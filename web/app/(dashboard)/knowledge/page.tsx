'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ChevronDown, ChevronRight, Columns3, Database, Filter,
  GripVertical, LayoutGrid, Library, List, Plus, Search as SearchIcon,
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
import { TemplatePicker } from '@/components/template-picker';
import { TagBadge } from '@/components/tag-badge';
import { SimilarSentenceTags } from '@/components/similar-sentences';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/client-api';
import { BatchActionBar } from '@/components/batch-action-bar';
import { KnowledgeExport } from '@/components/knowledge-export';
import type { ApiResponse } from '@/types';
import { useCognitiveMode } from '@/contexts/cognitive-mode-context';
import { CognitivePanel } from '@/components/cognitive-panel';
import { TYPE_LABELS, typeLabel } from '@/lib/i18n-labels';

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
  similarSentences?: string[] | string | null;
}

type ViewMode = 'list' | 'table' | 'board';
const VIEW_KEY = 'kivo-knowledge-view';
const SORT_ORDER_KEY = 'kivo-knowledge-custom-order';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'default', pending: 'outline', deprecated: 'destructive', archived: 'secondary',
};
const TYPE_COLORS: Record<string, string> = {
  fact: 'bg-blue-50 border-blue-200 text-blue-700',
  decision: 'bg-amber-50 border-amber-200 text-amber-700',
  methodology: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  experience: 'bg-purple-50 border-purple-200 text-purple-700',
  intent: 'bg-rose-50 border-rose-200 text-rose-700',
  meta: 'bg-slate-100 border-slate-200 text-slate-600',
};
const TYPE_KEYS = ['fact', 'decision', 'methodology', 'experience', 'intent', 'meta'];

function extractTitle(content: string) {
  const t = content.trim();
  if (!t) return '未命名';
  const first = t.split('\n').find(l => l.trim().length > 0) ?? t;
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

const STATUS_KEYS = ['active', 'pending', 'deprecated', 'archived'];
const STATUS_LABELS: Record<string, string> = {
  active: '活跃', pending: '待处理', deprecated: '已过时', archived: '已归档',
};

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
    { label: '', sortKey: '' },
    { label: '标题', sortKey: '' },
    { label: '类型', sortKey: '' },
    { label: '状态', sortKey: '' },
    { label: '相似句', sortKey: '' },
    { label: '置信度', sortKey: '-confidence' },
    { label: '创建', sortKey: '-createdAt' },
    { label: '更新', sortKey: '-updatedAt' },
  ];
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white/95 shadow-sm dark:border-slate-700 dark:bg-slate-900/95">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50/80 dark:border-slate-700 dark:bg-slate-800/80">
            {cols.map(c => (
              <th key={c.label} className="px-4 py-3 text-left font-medium text-slate-600 dark:text-slate-300">
                {c.sortKey ? (
                  <button className={`inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white ${sort === c.sortKey ? 'text-indigo-600 dark:text-indigo-400' : ''}`} onClick={() => onSort(c.sortKey)}>
                    {c.label}{sort === c.sortKey && <span className="text-xs">↓</span>}
                  </button>
                ) : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map(e => (
            <tr key={e.id} className={`border-b border-slate-50 transition-colors hover:bg-slate-50/50 dark:border-slate-800 dark:hover:bg-slate-800/50 ${selectedIds.has(e.id) ? 'bg-indigo-50/50 dark:bg-indigo-900/20' : ''}`}>
              <td className="w-10 px-4 py-3">
                <input type="checkbox" checked={selectedIds.has(e.id)} onChange={() => onToggle(e.id)} className="h-4 w-4 rounded border-slate-300 accent-indigo-600 cursor-pointer" aria-label={`选择条目`} />
              </td>
              <td className="max-w-xs px-4 py-3">
                <Link href={`/knowledge/${e.id}`} title={e.content.trim()} className="font-medium text-slate-800 hover:text-indigo-600 hover:underline dark:text-slate-200 dark:hover:text-indigo-400">{extractTitle(e.content)}</Link>
                {e.domain && <span className="ml-2 text-xs text-muted-foreground">{e.domain}</span>}
              </td>
              <td className="px-4 py-3">
                <InlineCellSelect value={e.type} options={TYPE_KEYS} labels={TYPE_LABELS} onSave={(v) => onPatch(e.id, 'type', v)} />
              </td>
              <td className="px-4 py-3">
                <InlineCellSelect value={e.status} options={STATUS_KEYS} labels={STATUS_LABELS} variant={STATUS_VARIANT} onSave={(v) => onPatch(e.id, 'status', v)} />
              </td>
              <td className="px-4 py-3 max-w-[200px]">
                {e.type === 'intent' ? (
                  <SimilarSentenceTags similarSentences={e.similarSentences} />
                ) : (
                  <span className="text-xs text-muted-foreground/40">—</span>
                )}
              </td>
              <td className="px-4 py-3 text-muted-foreground">{e.confidence != null ? `${(e.confidence * 100).toFixed(0)}%` : '—'}</td>
              <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{new Date(e.createdAt).toLocaleDateString('zh-CN')}</td>
              <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{new Date(e.updatedAt).toLocaleDateString('zh-CN')}</td>
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
        <div key={tk} className={`rounded-2xl border p-3 ${TYPE_COLORS[tk] ?? 'bg-slate-50 border-slate-200 dark:bg-slate-800/50 dark:border-slate-700'}`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider">{TYPE_LABELS[tk] ?? tk}</span>
            <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs font-medium dark:bg-slate-700/80">{grouped[tk]?.length ?? 0}</span>
          </div>
          <div className="space-y-2">
            {(grouped[tk] ?? []).map(e => (
              <Link key={e.id} href={`/knowledge/${e.id}`} title={e.content.trim()} className="block rounded-xl bg-white/90 p-3 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md dark:bg-slate-800/90">
                <p className="text-xs font-medium text-slate-800 line-clamp-2 dark:text-slate-200">{extractTitle(e.content)}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  {e.confidence != null && <span className="text-[10px] text-muted-foreground">{(e.confidence * 100).toFixed(0)}%</span>}
                  {e.domain && <span className="text-[10px] text-muted-foreground truncate">{e.domain}</span>}
                </div>
                {e.type === 'intent' && (
                  <div className="mt-1.5">
                    <SimilarSentenceTags similarSentences={e.similarSentences} />
                  </div>
                )}
              </Link>
            ))}
            {(grouped[tk]?.length ?? 0) === 0 && <p className="py-4 text-center text-[10px] text-muted-foreground/60">暂无</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

function SortableListItem({ entry }: { entry: KnowledgeEntry }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: 'relative' as const,
    zIndex: isDragging ? 10 : 'auto' as const,
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-stretch gap-0">
      <button
        {...attributes}
        {...listeners}
        className="flex items-center px-2 text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing shrink-0 touch-none dark:text-slate-600 dark:hover:text-slate-400"
        aria-label="拖拽排序"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <Link href={`/knowledge/${entry.id}`} title={entry.content.trim()} className="block flex-1 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:bg-accent dark:border-slate-700 dark:bg-slate-800/95 dark:hover:border-indigo-600">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm line-clamp-2 flex-1 text-slate-800 dark:text-slate-200">{entry.content}</p>
          <div className="flex gap-1 shrink-0">
            <Badge variant="secondary">{TYPE_LABELS[entry.type] ?? entry.type}</Badge>
            <Badge variant={STATUS_VARIANT[entry.status] ?? 'outline'}>{STATUS_LABELS[entry.status] ?? entry.status}</Badge>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
          {entry.domain && <span>域: {entry.domain}</span>}
          {entry.source?.reference && <span>来源: {entry.source.reference}</span>}
          {entry.confidence != null && <span>置信度: {(entry.confidence * 100).toFixed(0)}%</span>}
          <span>{new Date(entry.updatedAt).toLocaleDateString('zh-CN')}</span>
        </div>
        {entry.type === 'intent' && (
          <div className="mt-2">
            <SimilarSentenceTags similarSentences={entry.similarSentences} />
          </div>
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

function GroupedListView({ entries }: { entries: KnowledgeEntry[] }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [customOrder, setCustomOrder] = useState<Record<string, string[]>>({});

  useEffect(() => { setCustomOrder(loadCustomOrder()); }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const grouped = useMemo(() => {
    const m: Record<string, KnowledgeEntry[]> = {};
    for (const e of entries) (m[e.type] ??= []).push(e);
    return Object.entries(m)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tk, items]) => [tk, applyCustomOrder(items, customOrder[tk])] as const);
  }, [entries, customOrder]);

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
          <button className="mb-2 flex w-full items-center gap-2 text-left" onClick={() => setCollapsed(p => ({ ...p, [tk]: !p[tk] }))}>
            {collapsed[tk] ? <ChevronRight className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
            <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">{TYPE_LABELS[tk] ?? tk}</span>
            <span className="text-xs text-muted-foreground">({items.length})</span>
          </button>
          {!collapsed[tk] && (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => handleDragEnd(tk, e)}>
              <SortableContext items={items.map(e => e.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2 pl-6">
                  {items.map(e => <SortableListItem key={e.id} entry={e} />)}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      ))}
    </div>
  );
}

const VIEW_TABS: { mode: ViewMode; icon: typeof List; label: string }[] = [
  { mode: 'list', icon: List, label: '列表' },
  { mode: 'table', icon: Columns3, label: '表格' },
  { mode: 'board', icon: LayoutGrid, label: '看板' },
];

function KnowledgeListPageInner() {
  const searchParams = useSearchParams();
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [type, setType] = useState(searchParams.get('type') ?? '');
  const [status, setStatus] = useState(searchParams.get('status') ?? '');
  const [domain, setDomain] = useState(searchParams.get('domain') ?? '');
  const [source, setSource] = useState(searchParams.get('source') ?? '');
  const [quickSearch, setQuickSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('-updatedAt');
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const { isFocus, isOverview } = useCognitiveMode();
  const [tagFilter, setTagFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const saved = localStorage.getItem(VIEW_KEY) as ViewMode | null;
    if (saved === 'list' || saved === 'table' || saved === 'board') setViewMode(saved);
  }, []);

  function switchView(mode: ViewMode) {
    setViewMode(mode);
    localStorage.setItem(VIEW_KEY, mode);
  }

  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (status) params.set('status', status);
  if (domain.trim()) params.set('domain', domain.trim());
  if (source.trim()) params.set('source', source.trim());
  params.set('page', String(page));
  params.set('pageSize', '24');
  params.set('sort', sort);

  const { data, isLoading, error, mutate } = useApi<ApiResponse<KnowledgeEntry[]>>(`/api/v1/knowledge?${params.toString()}`);
  const entries = data?.data ?? [];
  const meta = data?.meta;

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
  if (error) return <ErrorState title="知识条目加载失败" description={error.message || '暂时拿不到知识列表，请稍后重试。'} onRetry={() => void mutate()} />;

  return (
    <div className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950 dark:text-white">知识条目</h1>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              多视图浏览知识库。按类型、状态筛选，或切换到看板视图按类型分组纵览。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:justify-end">
            <QuickCreateModal
              open={quickCreateOpen}
              onOpenChange={setQuickCreateOpen}
              onCreated={() => void mutate()}
              triggerLabel="新建"
            />
            <TemplatePicker onCreated={() => void mutate()} />
            <KnowledgeExport
              filteredEntries={filteredEntries}
              selectedIds={selectedIds}
              filterParams={params.toString()}
            />
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
              <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} className="h-4 w-4 rounded border-slate-300 accent-indigo-600 cursor-pointer" aria-label="全选/取消全选" />
              {selectedIds.size > 0 ? `已选 ${selectedIds.size}` : '全选'}
            </label>
            <div className="inline-flex items-center rounded-lg border border-slate-200 bg-white p-1 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              {VIEW_TABS.map(({ mode, icon: Icon, label }) => (
                <button
                  key={mode}
                  onClick={() => switchView(mode)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${viewMode === mode ? 'bg-slate-900 text-white shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-white'}`}
                  aria-label={`切换到${label}视图`}
                  aria-pressed={viewMode === mode}
                >
                  <Icon className="h-3.5 w-3.5" />{label}
                </button>
              ))}
            </div>
          </div>
        </div>

      <CognitivePanel visible={!isFocus}>
      <Card className="border-slate-200/80 bg-white/95 shadow-sm dark:border-slate-700 dark:bg-slate-900/95">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400">
            <Filter className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-[0.2em]">筛选与排序</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-5">
            <Select value={type || 'all-types'} onValueChange={v => { setType(v === 'all-types' ? '' : v); setPage(1); }}>
              <SelectTrigger className="w-full" aria-label="按知识类型筛选"><SelectValue placeholder="全部类型" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all-types">全部类型</SelectItem>
                {TYPE_KEYS.map(k => <SelectItem key={k} value={k}>{TYPE_LABELS[k]}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={status || 'all-statuses'} onValueChange={v => { setStatus(v === 'all-statuses' ? '' : v); setPage(1); }}>
              <SelectTrigger className="w-full" aria-label="按知识状态筛选"><SelectValue placeholder="全部状态" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all-statuses">全部状态</SelectItem>
                <SelectItem value="active">活跃</SelectItem>
                <SelectItem value="pending">待处理</SelectItem>
                <SelectItem value="deprecated">已过时</SelectItem>
              </SelectContent>
            </Select>
            <Input value={domain} onChange={e => { setDomain(e.target.value); setPage(1); }} placeholder="按知识域筛选" aria-label="按知识域筛选" />
            <Input value={source} onChange={e => { setSource(e.target.value); setPage(1); }} placeholder="按来源筛选" aria-label="按来源筛选" />
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="w-full" aria-label="排序方式"><SelectValue placeholder="最近更新" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="-updatedAt">最近更新</SelectItem>
                <SelectItem value="-createdAt">最近创建</SelectItem>
                <SelectItem value="-confidence">置信度</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" value={quickSearch} onChange={e => setQuickSearch(e.target.value)} placeholder="在当前结果内即时搜索" aria-label="即时搜索" />
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
          secondaryAction={{ label: '清空筛选', onClick: () => { setType(''); setStatus(''); setDomain(''); setSource(''); setTagFilter(''); setQuickSearch(''); setSort('-updatedAt'); setPage(1); }, variant: 'outline' }}
        />
      ) : (
        <>
          {viewMode === 'table' && <TableView entries={filteredEntries} sort={sort} onSort={setSort} onPatch={handlePatch} selectedIds={selectedIds} onToggle={toggleSelect} />}
          {viewMode === 'board' && <BoardView entries={filteredEntries} />}
          {viewMode === 'list' && <GroupedListView entries={filteredEntries} />}
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

      <BatchActionBar
        selectedIds={selectedIds}
        onClear={() => setSelectedIds(new Set())}
        onDeleted={() => { setSelectedIds(new Set()); void mutate(); }}
      />
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