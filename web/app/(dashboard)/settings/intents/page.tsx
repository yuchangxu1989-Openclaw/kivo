'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  BrainCircuit,
  Filter,
  Plus,
  Pencil,
  Trash2,
  Search as SearchIcon,
  FlaskConical,
  Loader2,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Zap,
  MessageSquare,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import type { ApiResponse } from '@/types';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/* ── Types ─────────────────────────────────────────────────────────────────── */

interface IntentSnippet {
  id: string;
  excerpt: string;
  hitAt: string;
}

interface IntentItem {
  id: string;
  name: string;
  description: string;
  positives: string[];
  negatives: string[];
  relatedEntryCount: number;
  recentHitCount: number;
  recentSnippets: IntentSnippet[];
  updateStatus: 'idle' | 'updating' | 'synced';
  updatedAt: string;
}

interface IntentData {
  items: IntentItem[];
}

interface IntentFormData {
  name: string;
  description: string;
  positives: string;
  negatives: string;
}

const EMPTY_FORM: IntentFormData = { name: '', description: '', positives: '', negatives: '' };

function formToPayload(form: IntentFormData) {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    positives: form.positives
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    negatives: form.negatives
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    relatedEntryCount: 0,
  };
}

function itemToForm(item: IntentItem): IntentFormData {
  return {
    name: item.name,
    description: item.description,
    positives: item.positives.join('\n'),
    negatives: item.negatives.join('\n'),
  };
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  idle: 'outline',
  updating: 'secondary',
  synced: 'default',
};

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  updating: '同步中',
  synced: '已同步',
};

/* ── Intent Form (Create / Edit) ───────────────────────────────────────────── */

function IntentForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  initial: IntentFormData;
  onSubmit: (data: IntentFormData) => Promise<void>;
  onCancel: () => void;
  submitLabel: string;
}) {
  const [form, setForm] = useState<IntentFormData>(initial);
  const [busy, setBusy] = useState(false);

  const valid = form.name.trim() && form.description.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      await onSubmit(form);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="intent-name" className="text-sm font-medium text-slate-700 dark:text-slate-200">
            意图名称 <span className="text-destructive">*</span>
          </label>
          <Input
            id="intent-name"
            placeholder="如：查询订单状态"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="intent-desc" className="text-sm font-medium text-slate-700 dark:text-slate-200">
            描述 <span className="text-destructive">*</span>
          </label>
          <Input
            id="intent-desc"
            placeholder="用户想要做什么"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="intent-pos" className="text-sm font-medium text-slate-700 dark:text-slate-200">
            正例（每行一条）
          </label>
          <textarea
            id="intent-pos"
            rows={3}
            placeholder={"我的订单到哪了\n帮我查一下物流"}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            value={form.positives}
            onChange={(e) => setForm({ ...form, positives: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="intent-neg" className="text-sm font-medium text-slate-700 dark:text-slate-200">
            负例（每行一条）
          </label>
          <textarea
            id="intent-neg"
            rows={3}
            placeholder={"我要退货\n修改收货地址"}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            value={form.negatives}
            onChange={(e) => setForm({ ...form, negatives: e.target.value })}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={!valid || busy}>
          {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
          {submitLabel}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

/* ── Intent Test Panel ─────────────────────────────────────────────────────── */

function IntentTestPanel({ items }: { items: IntentItem[] }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ name: string; confidence: number }[] | null>(null);

  function runTest() {
    const q = query.trim().toLowerCase();
    if (!q) return;

    // Client-side fuzzy matching against positives/negatives for demo
    const scored = items.map((item) => {
      let score = 0;
      const fields = [item.name, item.description, ...item.positives].map((s) => s.toLowerCase());
      for (const field of fields) {
        if (field.includes(q)) score += 0.3;
        // word overlap
        const words = q.split(/\s+/);
        for (const w of words) {
          if (w && field.includes(w)) score += 0.15;
        }
      }
      // penalize if matches negatives
      for (const neg of item.negatives) {
        if (neg.toLowerCase().includes(q)) score -= 0.2;
      }
      return { name: item.name, confidence: Math.min(1, Math.max(0, score)) };
    });

    scored.sort((a, b) => b.confidence - a.confidence);
    setResults(scored.filter((s) => s.confidence > 0).slice(0, 5));
  }

  return (
    <Card className="border-slate-200/80 bg-white/95 shadow-sm">
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2 text-indigo-600">
          <FlaskConical className="h-4 w-4" />
          <span className="text-xs font-medium uppercase tracking-[0.2em]">意图测试</span>
        </div>
        <CardTitle className="text-xl">输入文本，查看匹配结果</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="输入一段用户文本进行意图匹配测试…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runTest();
            }}
            aria-label="意图测试输入"
          />
          <Button onClick={runTest} disabled={!query.trim()}>
            <Zap className="mr-1 h-4 w-4" />
            测试
          </Button>
        </div>

        {results !== null && (
          <div className="space-y-2">
            {results.length === 0 ? (
              <p className="text-sm text-muted-foreground">未匹配到任何意图模式。</p>
            ) : (
              results.map((r) => (
                <div key={r.name} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
                  <span className="text-sm font-medium text-slate-800">{r.name}</span>
                  <Badge variant={r.confidence >= 0.5 ? 'default' : 'outline'}>
                    置信度 {(r.confidence * 100).toFixed(0)}%
                  </Badge>
                </div>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ── Intent Row ────────────────────────────────────────────────────────────── */

function IntentRow({
  item,
  onEdit,
  onDelete,
}: {
  item: IntentItem;
  onEdit: (item: IntentItem) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-slate-200 bg-white transition-shadow hover:shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-center gap-3 px-4 py-3">
        <BrainCircuit className="h-5 w-5 shrink-0 text-indigo-500" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{item.name}</span>
            <Badge variant={STATUS_VARIANT[item.updateStatus] ?? 'outline'}>
              {STATUS_LABEL[item.updateStatus] ?? item.updateStatus}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground truncate">{item.description}</p>
        </div>
        <div className="flex items-center gap-4 shrink-0 text-xs text-muted-foreground">
          <span title="关联知识条目">{item.relatedEntryCount} 条关联</span>
          <span
            title="近 30 天命中次数"
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
              item.recentHitCount > 0
                ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400'
            }`}
          >
            <Zap className="h-3 w-3" />
            {item.recentHitCount} 次命中
          </span>
          <span>{item.updatedAt}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" onClick={() => onEdit(item)} aria-label="编辑">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDelete(item.id)} aria-label="删除">
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)} aria-label={expanded ? '收起' : '展开'}>
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-slate-100 dark:border-slate-700 px-4 py-3 space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">正例</p>
              {item.positives.length > 0 ? (
                <ul className="space-y-1">
                  {item.positives.map((p, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-sm text-slate-700 dark:text-slate-300">
                      <Check className="mt-0.5 h-3 w-3 shrink-0 text-green-500" />
                      {p}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">暂无正例</p>
              )}
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">负例</p>
              {item.negatives.length > 0 ? (
                <ul className="space-y-1">
                  {item.negatives.map((n, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-sm text-slate-700 dark:text-slate-300">
                      <X className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
                      {n}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">暂无负例</p>
              )}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              近 30 天命中片段（{item.recentSnippets.length}）
            </p>
            {item.recentSnippets.length > 0 ? (
              <div className="space-y-1">
                {item.recentSnippets.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 text-sm">
                    <MessageSquare className="h-3 w-3 shrink-0 text-slate-400" />
                    <span className="text-slate-700 dark:text-slate-300 truncate">{s.excerpt}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{s.hitAt}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">暂无命中记录，该意图近 30 天内未被匹配到。</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Bubble Chart (FR-W13) ─────────────────────────────────────────────────── */

const BUBBLE_COLORS: Record<string, string> = {
  routing: 'bg-blue-100 text-blue-700 border-blue-200 hover:bg-blue-200',
  quality_gate: 'bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-200',
  context_enrichment: 'bg-purple-100 text-purple-700 border-purple-200 hover:bg-purple-200',
  decision_support: 'bg-amber-100 text-amber-700 border-amber-200 hover:bg-amber-200',
  correction: 'bg-rose-100 text-rose-700 border-rose-200 hover:bg-rose-200',
  default: 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200',
};

interface BubbleCategory {
  category: string;
  count: number;
  names: string[];
}

function IntentBubbleChart({
  items,
  onCategoryClick,
  activeCategory,
}: {
  items: IntentItem[];
  onCategoryClick: (category: string | null) => void;
  activeCategory: string | null;
}) {
  const categories = useMemo(() => {
    const map = new Map<string, { count: number; names: string[] }>();
    for (const item of items) {
      // Derive category from positives keywords or use 'default'
      const cat = item.positives.length > 0
        ? item.positives[0].split(/\s+/)[0].toLowerCase()
        : 'default';
      const existing = map.get(cat) ?? { count: 0, names: [] };
      existing.count += item.recentHitCount || 1;
      existing.names.push(item.name);
      map.set(cat, existing);
    }
    const result: BubbleCategory[] = [];
    for (const [category, data] of map) {
      result.push({ category, count: data.count, names: data.names });
    }
    return result.sort((a, b) => b.count - a.count);
  }, [items]);

  if (categories.length === 0) return null;

  const maxCount = Math.max(...categories.map((c) => c.count));

  return (
    <Card className="border-slate-200/80 bg-white/95 shadow-sm">
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2 text-indigo-600">
          <Zap className="h-4 w-4" />
          <span className="text-xs font-medium uppercase tracking-[0.2em]">高频意图主题</span>
        </div>
        <CardTitle className="text-lg">意图分布气泡图</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3 min-h-[120px] justify-center">
          {categories.map((cat) => {
            const ratio = cat.count / maxCount;
            const size = Math.max(48, Math.round(ratio * 120));
            const colorClass = BUBBLE_COLORS[cat.category] ?? BUBBLE_COLORS.default;
            const isActive = activeCategory === cat.category;

            return (
              <button
                key={cat.category}
                type="button"
                onClick={() => onCategoryClick(isActive ? null : cat.category)}
                className={`
                  flex flex-col items-center justify-center rounded-full border-2 transition-all cursor-pointer
                  ${colorClass}
                  ${isActive ? 'ring-2 ring-indigo-400 ring-offset-2 scale-110' : ''}
                `}
                style={{ width: `${size}px`, height: `${size}px` }}
                title={`${cat.category}: ${cat.count} 次命中\n包含: ${cat.names.join(', ')}`}
                aria-label={`意图类别 ${cat.category}，命中 ${cat.count} 次`}
                aria-pressed={isActive}
              >
                <span className="text-xs font-medium truncate max-w-[90%] px-1">
                  {cat.category}
                </span>
                <span className="text-[10px] opacity-70">{cat.count}</span>
              </button>
            );
          })}
        </div>
        {activeCategory && (
          <p className="mt-3 text-xs text-muted-foreground text-center">
            已筛选：{activeCategory}（点击气泡取消筛选）
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* ── Main Page ─────────────────────────────────────────────────────────────── */

export default function IntentsManagementPage() {
  const { data, isLoading, error, mutate } = useApi<ApiResponse<IntentData>>('/api/v1/intents');
  const items = useMemo(() => data?.data?.items ?? [], [data]);

  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'list' | 'create' | 'edit'>('list');
  const [editingItem, setEditingItem] = useState<IntentItem | null>(null);
  const [bubbleCategory, setBubbleCategory] = useState<string | null>(null);

  /* ── P0-4: Delete confirmation ── */
  const [deleteTarget, setDeleteTarget] = useState<IntentItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  /* ── P1-4: Model sync helper ── */
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function triggerModelSync() {
    try {
      await apiFetch('/api/v1/intents/sync', { method: 'POST' });
    } catch {
      // sync is best-effort; list already refreshed
    }
    // Auto-refresh status after 3 seconds
    syncTimerRef.current = setTimeout(() => {
      void mutate();
    }, 3000);
  }

  const filtered = useMemo(() => {
    let result = items;
    // Filter by bubble category
    if (bubbleCategory) {
      result = result.filter((item) => {
        const cat = item.positives.length > 0
          ? item.positives[0].split(/\s+/)[0].toLowerCase()
          : 'default';
        return cat === bubbleCategory;
      });
    }
    // Filter by search text
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.positives.some((p) => p.toLowerCase().includes(q)),
      );
    }
    return result;
  }, [items, search, bubbleCategory]);

  async function handleCreate(form: IntentFormData) {
    await apiFetch('/api/v1/intents', {
      method: 'POST',
      body: JSON.stringify(formToPayload(form)),
    });
    await mutate();
    setMode('list');
    void triggerModelSync();
  }

  async function handleEdit(form: IntentFormData) {
    if (!editingItem) return;
    await apiFetch('/api/v1/intents', {
      method: 'PUT',
      body: JSON.stringify({ id: editingItem.id, ...formToPayload(form) }),
    });
    await mutate();
    setMode('list');
    setEditingItem(null);
    void triggerModelSync();
  }

  function requestDelete(id: string) {
    const item = items.find((i) => i.id === id);
    if (item) setDeleteTarget(item);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/v1/intents?id=${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' });
      await mutate();
      void triggerModelSync();
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  function startEdit(item: IntentItem) {
    setEditingItem(item);
    setMode('edit');
  }

  if (isLoading) return <ListPageSkeleton filters={2} rows={4} />;

  if (error) {
    return (
      <ErrorState
        title="意图库加载失败"
        description={error.message || '暂时拿不到意图列表，请稍后重试。'}
        onRetry={() => void mutate()}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">意图库管理</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          管理意图模式：定义描述、正例、负例和关联动作。变更实时生效，可通过测试面板验证匹配效果。
        </p>
      </div>

      {/* Create / Edit Form */}
      {mode === 'create' && (
        <Card className="border-slate-200/80 bg-white/95 shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2 text-indigo-600">
              <Plus className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-[0.2em]">新增意图</span>
            </div>
            <CardTitle className="text-xl">定义新的意图模式</CardTitle>
          </CardHeader>
          <CardContent>
            <IntentForm
              initial={EMPTY_FORM}
              onSubmit={handleCreate}
              onCancel={() => setMode('list')}
              submitLabel="创建"
            />
          </CardContent>
        </Card>
      )}

      {mode === 'edit' && editingItem && (
        <Card className="border-slate-200/80 bg-white/95 shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2 text-indigo-600">
              <Pencil className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-[0.2em]">编辑意图</span>
            </div>
            <CardTitle className="text-xl">修改「{editingItem.name}」</CardTitle>
          </CardHeader>
          <CardContent>
            <IntentForm
              initial={itemToForm(editingItem)}
              onSubmit={handleEdit}
              onCancel={() => {
                setMode('list');
                setEditingItem(null);
              }}
              submitLabel="保存"
            />
          </CardContent>
        </Card>
      )}

      {/* Toolbar */}
      <Card className="border-slate-200/80 bg-white/95 shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2 text-indigo-600">
            <Filter className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-[0.2em]">搜索与操作</span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="搜索意图名称、描述或正例…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="搜索意图"
              />
            </div>
            {mode === 'list' && (
              <Button onClick={() => setMode('create')}>
                <Plus className="mr-1 h-4 w-4" />
                新增意图
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Bubble Chart (FR-W13) */}
      {items.length > 0 && (
        <IntentBubbleChart
          items={items}
          onCategoryClick={setBubbleCategory}
          activeCategory={bubbleCategory}
        />
      )}

      {/* Intent List */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={BrainCircuit}
          title={search ? '未找到匹配的意图' : '暂无意图模式'}
          description={search ? '尝试调整搜索关键词。' : '点击「新增意图」创建第一个意图模式。'}
          primaryAction={
            !search
              ? { label: '新增意图', onClick: () => setMode('create') }
              : undefined
          }
        />
      ) : (
        <div className="space-y-2">
          <span className="text-xs text-muted-foreground">
            共 {filtered.length} 个意图{search ? `（筛选自 ${items.length} 个）` : ''}
          </span>
          {filtered.map((item) => (
            <IntentRow key={item.id} item={item} onEdit={startEdit} onDelete={requestDelete} />
          ))}
        </div>
      )}

      {/* Test Panel */}
      {items.length > 0 && <IntentTestPanel items={items} />}

      {/* P0-4: Delete Confirmation Dialog */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="确认删除意图"
        description={deleteTarget ? `确定要删除意图「${deleteTarget.name}」吗？该意图关联了 ${deleteTarget.relatedEntryCount} 条知识条目，删除后不可恢复。` : ''}
        confirmLabel="删除"
        variant="destructive"
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
