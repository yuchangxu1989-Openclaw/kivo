'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { BookMarked, ChevronDown, ChevronUp, Download, Loader2, PencilLine, PlusCircle, Trash2, Upload, X } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { ApiResponse } from '@/types';
import type { DictionaryData, DictionaryEntry } from '@/lib/demo-dashboard-data';

const emptyForm = { term: '', definition: '', aliases: '', scope: '' };

export default function DictionarySettingsPage() {
  const { data, isLoading, error, mutate } = useApi<ApiResponse<DictionaryData>>('/api/v1/dictionary');
  const entries = data?.data.entries ?? [];

  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState('全部');
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DictionaryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchConfirm, setBatchConfirm] = useState(false);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const scopes = useMemo(() => ['全部', ...Array.from(new Set(entries.map((item) => item.scope)))], [entries]);

  const filteredEntries = useMemo(() => {
    return entries.filter((item) => {
      const matchSearch = !search.trim() || item.term.toLowerCase().includes(search.toLowerCase()) || item.aliases.some((alias) => alias.toLowerCase().includes(search.toLowerCase()));
      const matchScope = scopeFilter === '全部' || item.scope === scopeFilter;
      return matchSearch && matchScope;
    });
  }, [entries, search, scopeFilter]);

  const allSelected = filteredEntries.length > 0 && filteredEntries.every((e) => selectedIds.has(e.id));

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredEntries.map((e) => e.id)));
    }
  }, [allSelected, filteredEntries]);

  if (isLoading) {
    return <ListPageSkeleton filters={2} rows={4} />;
  }

  if (error) {
    return (
      <ErrorState
        title="系统字典加载失败"
        description={error.message || '暂时拿不到术语列表，请稍后重试。'}
        onRetry={() => void mutate()}
      />
    );
  }

  if (!data?.data) {
    return (
      <EmptyState
        icon={BookMarked}
        title="系统字典还是空的"
        description="先新增几个关键术语，后续 Agent 才能按统一定义工作。你也可以先回知识库确认已有内容，再来补齐词典。"
        primaryAction={{ label: '返回知识库', href: '/knowledge' }}
        secondaryAction={{ label: '查看活动流', href: '/activity', variant: 'outline' }}
      />
    );
  }

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
    setFormOpen(false);
  }

  function buildAliases(value: string) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }

  async function handleSubmit() {
    if (!form.term.trim() || !form.definition.trim()) return;

    setSubmitting(true);
    const payload = {
      id: editingId ?? undefined,
      term: form.term.trim(),
      definition: form.definition.trim(),
      aliases: buildAliases(form.aliases),
      scope: form.scope.trim() || '全局',
    };

    try {
      await apiFetch<ApiResponse<DictionaryData>>('/api/v1/dictionary', {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });

      setNotice(editingId ? `术语「${payload.term}」已更新，后续 Agent 会立即使用新定义。` : `术语「${payload.term}」已新增。`);
      resetForm();
      await mutate();
    } finally {
      setSubmitting(false);
    }
  }

  function handleEdit(entry: DictionaryEntry) {
    setEditingId(entry.id);
    setFormOpen(true);
    setForm({
      term: entry.term,
      definition: entry.definition,
      aliases: entry.aliases.join(', '),
      scope: entry.scope,
    });
  }

  function requestDelete(entry: DictionaryEntry) {
    setDeleteTarget(entry);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch<ApiResponse<DictionaryData>>(`/api/v1/dictionary?id=${encodeURIComponent(deleteTarget.id)}`, {
        method: 'DELETE',
      });
      setNotice('术语已删除，后续会话不再使用这一定义。');
      if (editingId === deleteTarget.id) resetForm();
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(deleteTarget.id); return next; });
      await mutate();
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  async function handleBatchDelete() {
    if (selectedIds.size === 0) return;
    setBatchDeleting(true);
    const ids = Array.from(selectedIds);
    const results = await Promise.all(
      ids.map((id) =>
        apiFetch<ApiResponse<DictionaryData>>(`/api/v1/dictionary?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
          .then(() => true)
          .catch(() => false)
      ),
    );
    const success = results.filter(Boolean).length;
    const failed = results.length - success;
    if (failed === 0) {
      setNotice(`已批量删除 ${success} 条术语。`);
    } else {
      setNotice(`批量删除完成：${success} 条成功，${failed} 条失败。`);
    }
    setSelectedIds(new Set());
    setBatchConfirm(false);
    setBatchDeleting(false);
    if (editingId && ids.includes(editingId)) resetForm();
    await mutate();
  }

  function handleBatchExport() {
    const selected = entries.filter((e) => selectedIds.has(e.id));
    const blob = new Blob([JSON.stringify(selected, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kivo-dictionary-selected-${selected.length}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice(`已导出 ${selected.length} 条选中术语。`);
  }

  function handleExport() {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kivo-dictionary-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice('字典已导出为 JSON 文件。');
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const items = JSON.parse(text) as Array<{ term?: string; definition?: string; aliases?: string[]; scope?: string }>;
      if (!Array.isArray(items)) throw new Error('格式错误');
      let imported = 0;
      for (const item of items) {
        const term = typeof item.term === 'string' ? item.term.trim() : '';
        const definition = typeof item.definition === 'string' ? item.definition.trim() : '';
        if (!term || !definition) continue;
        await apiFetch<ApiResponse<DictionaryData>>('/api/v1/dictionary', {
          method: 'POST',
          body: JSON.stringify({
            term,
            definition,
            aliases: Array.isArray(item.aliases) ? item.aliases : [],
            scope: typeof item.scope === 'string' ? item.scope.trim() || '全局' : '全局',
          }),
        });
        imported++;
      }
      await mutate();
      setNotice(`批量导入完成，成功导入 ${imported} 条术语。`);
    } catch {
      setNotice('导入失败：请确认文件为有效的 JSON 数组格式。');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">系统字典管理</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          查看 / 新增 / 编辑 / 删除术语，支持按名称搜索和按适用范围筛选。字典变更后，后续 Agent 立即使用新定义。
        </p>
      </div>

      {/* AC4: Batch import/export */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleExport} aria-label="导出字典">
          <Download className="mr-2 h-4 w-4" />导出 JSON
        </Button>
        <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} aria-label="导入字典">
          <Upload className="mr-2 h-4 w-4" />批量导入
        </Button>
        <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImport} aria-label="选择导入文件" />
        <div className="h-5 w-px bg-slate-200" />
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} className="h-4 w-4 rounded border-slate-300 accent-indigo-600 cursor-pointer" aria-label="全选/取消全选" />
          {selectedIds.size > 0 ? `已选 ${selectedIds.size}` : '全选'}
        </label>
      </div>

      {/* AC2: Collapsible form */}
      <Card className="border-slate-200/80 bg-white/95 shadow-sm">
        <CardHeader className="cursor-pointer" onClick={() => { if (!editingId) setFormOpen(!formOpen); }}>
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl">{editingId ? '编辑术语' : '新增术语'}</CardTitle>
            <Button variant="ghost" size="sm" aria-label={formOpen ? '收起表单' : '展开表单'}>
              {formOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        </CardHeader>
        {formOpen && (
          <CardContent className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <Input placeholder="术语名称（必填）" value={form.term} onChange={(e) => setForm((prev) => ({ ...prev, term: e.target.value }))} aria-label="术语名称" />
              <Input placeholder="适用范围（选填）" value={form.scope} onChange={(e) => setForm((prev) => ({ ...prev, scope: e.target.value }))} aria-label="适用范围" />
            </div>
            <Input placeholder="定义说明（必填）" value={form.definition} onChange={(e) => setForm((prev) => ({ ...prev, definition: e.target.value }))} aria-label="术语定义" />
            <Input placeholder="别名 / 同义词（逗号分隔）" value={form.aliases} onChange={(e) => setForm((prev) => ({ ...prev, aliases: e.target.value }))} aria-label="术语别名" />
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleSubmit} disabled={submitting || !form.term.trim() || !form.definition.trim()} aria-label={editingId ? '保存术语修改' : '新增术语'}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlusCircle className="mr-2 h-4 w-4" />}{editingId ? '保存修改' : '新增术语'}
              </Button>
              {editingId && (
                <Button variant="outline" disabled={submitting} onClick={resetForm} aria-label="取消术语编辑">取消编辑</Button>
              )}
            </div>
            {notice && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
          </CardContent>
        )}
      </Card>

      <Card className="border-slate-200/80 bg-white/95 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl">字典列表</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row">
            <Input placeholder="按名称或别名搜索" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="搜索术语" />
            <Select value={scopeFilter} onValueChange={setScopeFilter}>
              <SelectTrigger className="lg:w-56" aria-label="按适用范围筛选术语">
                <SelectValue placeholder="全部范围" />
              </SelectTrigger>
              <SelectContent>
                {scopes.map((scope) => (
                  <SelectItem key={scope} value={scope}>{scope}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3">
            {filteredEntries.length === 0 ? (
              <EmptyState
                icon={BookMarked}
                title="当前筛选条件下没有术语"
                description="试试换个范围、清空搜索词，或者直接新增一个新术语。"
                primaryAction={{ label: '清空筛选', onClick: () => { setSearch(''); setScopeFilter('全部'); } }}
                secondaryAction={{ label: '新增术语', onClick: () => document.querySelector<HTMLInputElement>('input[placeholder="术语名称（必填）"]')?.focus(), variant: 'outline' }}
                className="shadow-none"
              />
            ) : filteredEntries.map((entry) => (
              <div key={entry.id} className={`rounded-2xl border p-4 ${selectedIds.has(entry.id) ? 'border-indigo-300 bg-indigo-50/50' : 'border-slate-200 bg-slate-50/80'}`}>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="flex gap-3">
                    <input type="checkbox" checked={selectedIds.has(entry.id)} onChange={() => toggleSelect(entry.id)} className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 accent-indigo-600 cursor-pointer" aria-label={`选择术语 ${entry.term}`} />
                    <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold text-slate-950">{entry.term}</h2>
                      <Badge variant="secondary">{entry.scope}</Badge>
                    </div>
                    <p className="text-sm leading-6 text-slate-700">{entry.definition}</p>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {entry.aliases.length > 0 ? entry.aliases.map((alias) => (
                        <Badge key={alias} variant="outline">{alias}</Badge>
                      )) : <span>无别名</span>}
                    </div>
                    <p className="text-xs text-muted-foreground">更新时间：{entry.updatedAt}</p>
                  </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" disabled={submitting} onClick={() => handleEdit(entry)} aria-label={`编辑术语 ${entry.term}`}>
                      {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PencilLine className="mr-2 h-4 w-4" />}编辑
                    </Button>
                    <Button variant="destructive" size="sm" disabled={submitting} onClick={() => requestDelete(entry)} aria-label={`删除术语 ${entry.term}`}>
                      {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}删除
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-200/80 bg-slate-950 text-white shadow-sm">
        <CardContent className="flex items-center gap-3 p-6 text-sm leading-6 text-slate-300">
          <BookMarked className="h-5 w-5 shrink-0 text-indigo-300" />
          字典页已通过 `/api/v1/dictionary` 走动态 API，支持查看、新增、编辑、删除和筛选。
        </CardContent>
      </Card>

      {/* AC3: Delete confirmation dialog */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={`确认删除术语「${deleteTarget?.term ?? ''}」？`}
        description="删除后，后续会话将不再使用这一定义。此操作不可撤销。"
        confirmLabel="删除"
        variant="destructive"
        loading={deleting}
        onConfirm={confirmDelete}
      />

      {/* Batch action bar */}
      {selectedIds.size > 0 && (
        <div
          className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-slate-200 bg-white/95 px-5 py-3 shadow-lg backdrop-blur-sm transition-all"
          role="toolbar"
          aria-label="批量操作"
        >
          <span className="text-sm font-medium text-slate-700">
            已选 {selectedIds.size} 项
          </span>

          <div className="h-5 w-px bg-slate-200" />

          {batchConfirm ? (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-1.5" role="alert">
              <span className="text-sm text-red-700">
                确定删除 {selectedIds.size} 项？不可撤销
              </span>
              <Button variant="destructive" size="sm" disabled={batchDeleting} onClick={() => void handleBatchDelete()}>
                {batchDeleting ? '删除中…' : '确认删除'}
              </Button>
              <Button variant="ghost" size="sm" disabled={batchDeleting} onClick={() => setBatchConfirm(false)}>
                取消
              </Button>
            </div>
          ) : (
            <Button variant="destructive" size="sm" onClick={() => setBatchConfirm(true)}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              删除
            </Button>
          )}

          <Button variant="outline" size="sm" onClick={handleBatchExport}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            导出选中
          </Button>

          <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
            <X className="mr-1.5 h-3.5 w-3.5" />
            取消选择
          </Button>
        </div>
      )}
    </div>
  );
}
