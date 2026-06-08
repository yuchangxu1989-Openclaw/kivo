'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { mutate } from 'swr';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Edit3,
  FilePlus2,
  MoreHorizontal,
  Network,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { ApiResponse } from '@/types';
import { ContentRenderer } from '@/components/wiki/content-renderer';
import { DirectoryManager, type WikiTreeNode } from '@/components/wiki/directory-manager';
import type { SubjectTreeNode } from '@/lib/types/subject';

interface WikiSpace {
  id: string;
  title: string;
  description: string;
  summary: string;
  status: string;
  icon?: string;
  entryCount: number;
  createdAt: string;
  updatedAt: string;
}

interface WikiEntryItem {
  id: string;
  title: string;
  summary: string;
  type: string;
  parentId: string | null;
  parentTitle?: string | null;
  updatedAt: string;
  matchReason?: string;
}

interface WikiPageDetail extends WikiEntryItem {
  content: string;
  tags: string[];
  status: string;
  version: number;
  createdAt: string;
  metadata?: {
    extra?: {
      sourceRefs?: Array<{ label?: string; uri?: string; page?: number | string; paragraph?: string }>;
      graphNodeHref?: string;
    };
  };
}

interface WikiRelatedItem {
  id: string;
  title: string;
  summary: string;
  knowledgeType: string;
  direction: 'outgoing' | 'incoming';
  origin: 'wiki_links' | 'graph_edges';
  placeholder?: { reason: string };
  weight?: number;
}

interface WikiRelatedGroup {
  type: string;
  label: string;
  items: WikiRelatedItem[];
}

interface WikiRelatedResponse {
  pageId: string;
  total: number;
  groups: WikiRelatedGroup[];
}

type SpaceDialogState = { mode: 'create' } | { mode: 'edit'; space: WikiSpace } | null;
type DirectoryDialogState = { mode: 'create'; parentId: string; parentTitle: string } | { mode: 'rename'; node: WikiTreeNode } | null;
type EntryDialogState = { mode: 'create' } | { mode: 'edit'; entry: WikiPageDetail } | null;

function useFlashMessage() {
  const [message, setMessage] = useState<string | null>(null);
  return {
    message,
    showMessage(next: string) {
      setMessage(next);
      window.setTimeout(() => setMessage(null), 2500);
    },
  };
}

async function sendJson<T>(url: string, method: string, body?: unknown) {
  return apiFetch<T>(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function EntryDialog({
  state,
  open,
  selectedSpaceId,
  selectedDirectoryId,
  directoryOptions,
  onClose,
  onSaved,
}: {
  state: EntryDialogState;
  open: boolean;
  selectedSpaceId: string | null;
  selectedDirectoryId: string | null;
  directoryOptions: Array<{ id: string; title: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [content, setContent] = useState('');
  const [type, setType] = useState('fact');
  const [tags, setTags] = useState('');
  const [parentId, setParentId] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!state || !open) return;
    if (state.mode === 'edit') {
      setTitle(state.entry.title);
      setSummary(state.entry.summary || '');
      setContent(state.entry.content);
      setType(state.entry.type || 'fact');
      setTags(state.entry.tags.join(', '));
      setParentId(state.entry.parentId || selectedSpaceId || '');
      return;
    }
    setTitle('');
    setSummary('');
    setContent('');
    setType('fact');
    setTags('');
    setParentId(selectedDirectoryId || selectedSpaceId || '');
  }, [open, selectedDirectoryId, selectedSpaceId, state]);

  const submit = async () => {
    if (!selectedSpaceId || !title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      const body = {
        title: title.trim(),
        summary: summary.trim(),
        content: content.trim(),
        type,
        tags: tags.split(',').map((item) => item.trim()).filter(Boolean),
        parentId: parentId || selectedSpaceId,
      };
      if (state?.mode === 'edit') {
        await sendJson(`/api/wiki/pages/${state.entry.id}`, 'PATCH', body);
      } else {
        await sendJson(`/api/wiki/spaces/${selectedSpaceId}/entries`, 'POST', body);
      }
      await mutate((key) => typeof key === 'string' && key.startsWith(`/api/wiki/spaces/${selectedSpaceId}/entries`), undefined, { revalidate: true });
      await mutate(`/api/wiki/spaces/${selectedSpaceId}/directories`);
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{state?.mode === 'edit' ? '编辑知识点' : '新建知识点'}</DialogTitle>
          <DialogDescription>目录是章节分类，知识点必须挂在某个目录或空间根目录下。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2 md:grid-cols-[1fr_220px]">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="知识点标题" />
            <select value={parentId} onChange={(event) => setParentId(event.target.value)} className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900">
              <option value={selectedSpaceId || ''}>空间根目录</option>
              {directoryOptions.map((directory) => (
                <option key={directory.id} value={directory.id}>{directory.title}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-2 md:grid-cols-[220px_1fr]">
            <select value={type} onChange={(event) => setType(event.target.value)} className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900">
              <option value="fact">fact</option>
              <option value="methodology">methodology</option>
              <option value="decision">decision</option>
              <option value="experience">experience</option>
              <option value="meta">meta</option>
            </select>
            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，逗号分隔" />
          </div>
          <Textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="摘要，可选" />
          <Textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="支持 LaTeX，例如 $$P(A|B)=P(A\\cap B)/P(B)$$，也支持 Markdown 图片 ![alt](https://...)" className="min-h-72" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>取消</Button>
          <Button onClick={() => void submit()} disabled={saving || !title.trim() || !content.trim()}>{saving ? '保存中…' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function buildDirectoryOptions(tree?: WikiTreeNode): Array<{ id: string; title: string }> {
  const rows: Array<{ id: string; title: string }> = [];
  const visit = (node: WikiTreeNode, depth: number) => {
    for (const child of node.children) {
      if (child.type !== 'directory') continue;
      rows.push({ id: child.id, title: `${'　'.repeat(depth)}${child.title}` });
      visit(child, depth + 1);
    }
  };
  if (tree) visit(tree, 0);
  return rows;
}

function hasDirectoryChildren(tree?: WikiTreeNode, directoryId?: string | null): boolean {
  const node = findTreeNode(tree, directoryId);
  return node?.children.some((child) => child.type === 'directory') ?? false;
}

function findTreeNode(tree?: WikiTreeNode, nodeId?: string | null): WikiTreeNode | null {
  if (!tree || !nodeId) return null;
  const visit = (node: WikiTreeNode): WikiTreeNode | null => {
    if (node.id === nodeId) return node;
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(tree);
}

function countTreeNodes(node: SubjectTreeNode, acc: number): number {
  let count = acc + 1;
  for (const child of node.children) {
    count = countTreeNodes(child, count);
  }
  return count;
}

function SubjectTreeNodeDisplay({
  node,
  depth,
  onSelect,
}: {
  node: SubjectTreeNode;
  depth: number;
  onSelect: (id: string, name: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (hasChildren) setExpanded((v) => !v);
          onSelect(node.id, node.name);
        }}
        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-slate-100 ${depth === 0 ? 'font-semibold text-slate-800' : 'text-slate-600'}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        {hasChildren && (
          <ChevronRight
            className={`h-3 w-3 shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        )}
        {!hasChildren && <span className="w-3 shrink-0" />}
        <span className="truncate">{node.name}</span>
        {node.materialCount > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
            {node.materialCount}
          </span>
        )}
      </button>
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <SubjectTreeNodeDisplay key={child.id} node={child} depth={depth + 1} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SpaceManager() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedSpaceId = searchParams?.get('space') ?? null;
  const requestedPageId = searchParams?.get('page') ?? null;
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(requestedSpaceId);
  const [selectedDirectoryId, setSelectedDirectoryId] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(requestedPageId);
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('');
  const [spaceFilter, setSpaceFilter] = useState('');
  const [spaceDialog, setSpaceDialog] = useState<SpaceDialogState>(null);
  const [directoryDialog, setDirectoryDialog] = useState<DirectoryDialogState>(null);
  const [entryDialog, setEntryDialog] = useState<EntryDialogState>(null);
  const [spaceForm, setSpaceForm] = useState({ title: '', description: '', icon: '📘' });
  const [directoryTitle, setDirectoryTitle] = useState('');
  const { message, showMessage } = useFlashMessage();

  const { data: spacesData, isLoading: spacesLoading, error: spacesError } = useApi<ApiResponse<WikiSpace[]>>('/api/wiki/spaces');
  const selectedSpace = (spacesData?.data ?? []).find((space) => space.id === selectedSpaceId) ?? null;
  const spaceSearch = spaceFilter.trim().toLowerCase();
  const visibleSpaces = (spacesData?.data ?? []).filter((space) => {
    if (!spaceSearch) return true;
    return `${space.title} ${space.description}`.toLowerCase().includes(spaceSearch);
  });

  useEffect(() => {
    if (!selectedSpaceId && visibleSpaces.length > 0) {
      const fallback = requestedSpaceId && visibleSpaces.some((space) => space.id === requestedSpaceId)
        ? requestedSpaceId
        : visibleSpaces[0].id;
      setSelectedSpaceId(fallback);
      setSelectedDirectoryId(fallback);
    }
  }, [selectedSpaceId, visibleSpaces, requestedSpaceId]);

  const { data: treeData } = useApi<{ data: WikiTreeNode }>(selectedSpaceId ? `/api/wiki/spaces/${selectedSpaceId}/directories` : null);
  const entryParams = new URLSearchParams({
    page: String(page),
    pageSize: '20',
  });
  if (selectedDirectoryId && selectedSpaceId && selectedDirectoryId !== selectedSpaceId) entryParams.set('directoryId', selectedDirectoryId);
  if (typeFilter !== 'all') entryParams.set('type', typeFilter);
  if (tagFilter.trim()) entryParams.set('tag', tagFilter.trim());
  if (searchQuery.trim()) entryParams.set('q', searchQuery.trim());
  const entriesUrl = selectedSpaceId ? `/api/wiki/spaces/${selectedSpaceId}/entries?${entryParams.toString()}` : null;
  const { data: entriesData, isLoading: entriesLoading } = useApi<ApiResponse<WikiEntryItem[]>>(entriesUrl);
  const { data: pageData, error: pageError } = useApi<{ data: WikiPageDetail }>(selectedPageId ? `/api/wiki/pages/${selectedPageId}` : null);
  const { data: relatedData, isLoading: relatedLoading, error: relatedError } = useApi<{ data: WikiRelatedResponse }>(selectedPageId ? `/api/wiki/pages/${selectedPageId}/links` : null);
  const {
    data: subjectsData,
    error: subjectsError,
    isLoading: subjectsLoading,
    mutate: refetchSubjects,
  } = useApi<ApiResponse<SubjectTreeNode[]>>('/api/subjects');

  const tree = treeData?.data;
  const entries = entriesData?.data ?? [];
  const meta = entriesData?.meta;
  const directoryOptions = useMemo(() => buildDirectoryOptions(tree), [tree]);
  const selectedNodeHasSubdirectories = useMemo(
    () => hasDirectoryChildren(tree, selectedDirectoryId),
    [tree, selectedDirectoryId],
  );
  const selectedDirectoryTitle = useMemo(
    () => findTreeNode(tree, selectedDirectoryId)?.title ?? selectedSpace?.title ?? '',
    [tree, selectedDirectoryId, selectedSpace?.title],
  );

  const openSpaceDialog = (state: SpaceDialogState) => {
    setSpaceDialog(state);
    if (state?.mode === 'edit') {
      setSpaceForm({ title: state.space.title, description: state.space.description, icon: state.space.icon || '📘' });
      return;
    }
    setSpaceForm({ title: '', description: '', icon: '📘' });
  };

  const openDirectoryDialog = (state: DirectoryDialogState) => {
    setDirectoryDialog(state);
    setDirectoryTitle(state?.mode === 'rename' ? state.node.title : '');
  };

  const saveSpace = async () => {
    if (!spaceForm.title.trim()) return;
    if (spaceDialog?.mode === 'edit') {
      await sendJson(`/api/wiki/spaces/${spaceDialog.space.id}`, 'PATCH', spaceForm);
    } else {
      await sendJson('/api/wiki/spaces', 'POST', spaceForm);
    }
    await mutate('/api/wiki/spaces');
    setSpaceDialog(null);
    showMessage('空间已保存');
  };

  const saveDirectory = async () => {
    if (!selectedSpaceId || !directoryDialog || !directoryTitle.trim()) return;
    if (directoryDialog.mode === 'rename') {
      await sendJson(`/api/wiki/spaces/${selectedSpaceId}/directories/${directoryDialog.node.id}`, 'PATCH', { title: directoryTitle.trim() });
    } else {
      await sendJson(`/api/wiki/spaces/${selectedSpaceId}/directories`, 'POST', { title: directoryTitle.trim(), parentId: directoryDialog.parentId });
    }
    await mutate(`/api/wiki/spaces/${selectedSpaceId}/directories`);
    setDirectoryDialog(null);
    showMessage('目录已保存');
  };

  const deleteSpace = async (space: WikiSpace) => {
    if (!window.confirm(`确认删除空间「${space.title}」？`)) return;
    await sendJson(`/api/wiki/spaces/${space.id}`, 'DELETE');
    await mutate('/api/wiki/spaces');
    setSelectedPageId(null);
    if (selectedSpaceId === space.id) {
      setSelectedSpaceId(null);
      setSelectedDirectoryId(null);
    }
    showMessage('空间已删除');
  };

  const deleteDirectory = async (node: WikiTreeNode) => {
    if (!selectedSpaceId) return;
    if (!window.confirm(`确认删除目录「${node.title}」？目录下知识点会一起删除。`)) return;
    await sendJson(`/api/wiki/spaces/${selectedSpaceId}/directories/${node.id}`, 'DELETE');
    await mutate(`/api/wiki/spaces/${selectedSpaceId}/directories`);
    await mutate((key) => typeof key === 'string' && key.startsWith(`/api/wiki/spaces/${selectedSpaceId}/entries`), undefined, { revalidate: true });
    setSelectedDirectoryId(selectedSpaceId);
    showMessage('目录已删除');
  };

  const deleteEntry = async (entry: WikiPageDetail) => {
    if (!window.confirm(`确认删除知识点「${entry.title}」？`)) return;
    await sendJson(`/api/wiki/pages/${entry.id}`, 'DELETE');
    await mutate((key) => typeof key === 'string' && key.startsWith(`/api/wiki/spaces/${selectedSpaceId}/entries`), undefined, { revalidate: true });
    await mutate(`/api/wiki/spaces/${selectedSpaceId}/directories`);
    setSelectedPageId(null);
    showMessage('知识点已删除');
  };

  const moveNode = async (nodeId: string, newParentId: string, sortOrder?: number) => {
    if (!selectedSpaceId) return;
    await sendJson(`/api/wiki/spaces/${selectedSpaceId}/directories/${nodeId}/move`, 'PATCH', { newParentId, sortOrder });
    await mutate(`/api/wiki/spaces/${selectedSpaceId}/directories`);
    await mutate((key) => typeof key === 'string' && key.startsWith(`/api/wiki/spaces/${selectedSpaceId}/entries`), undefined, { revalidate: true });
    showMessage('层级已更新');
  };

  const restoreToRoot = async (rawNode: string) => {
    if (!selectedSpaceId || !rawNode) return;
    try {
      const node = JSON.parse(rawNode) as WikiTreeNode;
      await moveNode(node.id, selectedSpaceId);
    } catch {
      showMessage('拖拽数据无效');
    }
  };

  if (spacesLoading) return <ListPageSkeleton filters={2} rows={4} />;
  if (spacesError) return <ErrorState title="领域知识库加载失败" description={spacesError.message} />;

  return (
    <div className="space-y-6 bg-white text-black">
      {message && <div className="fixed right-6 top-6 z-50 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 shadow-lg">{message}</div>}

      <EntryDialog state={entryDialog} open={entryDialog !== null} selectedSpaceId={selectedSpaceId} selectedDirectoryId={selectedDirectoryId} directoryOptions={directoryOptions} onClose={() => setEntryDialog(null)} onSaved={() => showMessage('知识点已保存')} />

      <Dialog open={spaceDialog !== null} onOpenChange={(value) => !value && setSpaceDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{spaceDialog?.mode === 'edit' ? '编辑空间' : '新建空间'}</DialogTitle>
            <DialogDescription>名称必须全局唯一，描述用于定义这个知识库的范围。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Input value={spaceForm.icon} onChange={(event) => setSpaceForm((current) => ({ ...current, icon: event.target.value }))} placeholder="图标" />
            <Input value={spaceForm.title} onChange={(event) => setSpaceForm((current) => ({ ...current, title: event.target.value }))} placeholder="空间名称" />
            <Textarea value={spaceForm.description} onChange={(event) => setSpaceForm((current) => ({ ...current, description: event.target.value }))} placeholder="知识范围定义" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSpaceDialog(null)}>取消</Button>
            <Button onClick={() => void saveSpace()} disabled={!spaceForm.title.trim()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={directoryDialog !== null} onOpenChange={(value) => !value && setDirectoryDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{directoryDialog?.mode === 'rename' ? '重命名目录' : '新建目录'}</DialogTitle>
            <DialogDescription>{directoryDialog?.mode === 'create' ? `父级：${directoryDialog.parentTitle}` : '目录表示章节或分类，知识点不要和目录混为同层。'}</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input value={directoryTitle} onChange={(event) => setDirectoryTitle(event.target.value)} placeholder="目录名称" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDirectoryDialog(null)}>取消</Button>
            <Button onClick={() => void saveDirectory()} disabled={!directoryTitle.trim()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950">领域知识库</h1>
            <p className="text-sm text-slate-600">目录承载章节分类，条目承载具体知识点。搜索框调用后端 BGE-M3 语义检索。</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href="/graph"><Network className="mr-2 h-4 w-4" />图谱视图</Link>
            </Button>
            <Button onClick={() => openSpaceDialog({ mode: 'create' })}>
              <Plus className="mr-2 h-4 w-4" />新建空间
            </Button>
          </div>
        </div>

      {visibleSpaces.length === 0 ? (
        <EmptyState icon={BookOpen} title="暂无知识空间" description="先创建一个领域知识库空间。" />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[320px_1fr]">
          <div className="space-y-4">
            <Card className="border-slate-200 bg-white shadow-sm">
              <CardContent className="p-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input value={spaceFilter} onChange={(event) => setSpaceFilter(event.target.value)} className="pl-9" placeholder="搜索空间名称" />
                </div>
              </CardContent>
            </Card>

            <div className="space-y-3">
              {visibleSpaces.map((space) => (
                <Card key={space.id} className={`border-slate-200 bg-white shadow-sm ${space.id === selectedSpaceId ? 'ring-2 ring-sky-200' : ''}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <button type="button" onClick={() => { setSelectedSpaceId(space.id); setSelectedDirectoryId(space.id); setSelectedPageId(null); setPage(1); }} className="flex min-w-0 flex-1 gap-3 text-left">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-sky-50 text-xl">{space.icon || '📘'}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-slate-950">{space.title}</span>
                          <span className="mt-1 line-clamp-2 block text-xs text-slate-500">{space.description || space.summary || '暂无描述'}</span>
                          <span className="mt-2 block text-xs text-slate-400">{space.entryCount} 条知识点 · 更新于 {new Date(space.updatedAt).toLocaleDateString('zh-CN')}</span>
                        </span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openSpaceDialog({ mode: 'edit', space })}>
                            <Edit3 className="mr-2 h-4 w-4" />编辑空间
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-red-600" onClick={() => void deleteSpace(space)}>
                            <Trash2 className="mr-2 h-4 w-4" />删除空间
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {selectedSpace && (
              <Card className="border-slate-200 bg-white shadow-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm text-slate-900">目录树</CardTitle>
                    <Button variant="ghost" size="sm" className="text-slate-500" onClick={() => openDirectoryDialog({ mode: 'create', parentId: selectedSpace.id, parentTitle: selectedSpace.title })}>
                      <Plus className="mr-2 h-4 w-4" />新建目录
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <DirectoryManager
                    tree={tree}
                    spaceId={selectedSpace.id}
                    selectedDirectoryId={selectedDirectoryId}
                    selectedPageId={selectedPageId}
                    onSelectDirectory={(id) => { setSelectedDirectoryId(id); setSelectedPageId(null); setPage(1); }}
                    onSelectPage={setSelectedPageId}
                    onCreateDirectory={(parentId, parentTitle) => openDirectoryDialog({ mode: 'create', parentId, parentTitle })}
                    onRenameDirectory={(node) => openDirectoryDialog({ mode: 'rename', node })}
                    onDeleteDirectory={(node) => void deleteDirectory(node)}
                    onMoveNode={moveNode}
                    onRestoreToRoot={restoreToRoot}
                    showMessage={showMessage}
                  />
                </CardContent>
              </Card>
            )}

            <Card className="border-slate-200 bg-white shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm text-slate-900">学科目录</CardTitle>
                  <Badge variant="outline" className="text-[10px]">
                    {subjectsError
                      ? '加载失败'
                      : `${(subjectsData?.data ?? []).reduce((n, node) => countTreeNodes(node, n), 0)} 节点`}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="max-h-80 overflow-y-auto">
                {subjectsError ? (
                  <div className="space-y-2 py-2" role="alert">
                    <p className="text-xs text-red-600">学科目录加载失败，请稍后重试。</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => void refetchSubjects()}
                    >
                      重试
                    </Button>
                  </div>
                ) : subjectsLoading || !subjectsData ? (
                  <div className="h-10 animate-pulse rounded-xl bg-slate-100" />
                ) : subjectsData.data.length === 0 ? (
                  <p className="text-xs text-slate-500">暂无学科节点。</p>
                ) : (
                  subjectsData.data.map((subject) => (
                    <SubjectTreeNodeDisplay
                      key={subject.id}
                      node={subject}
                      depth={0}
                      onSelect={(id, name) => {
                        router.push(`/system/subject-domains?id=${id}`)
                      }}
                    />
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            {selectedSpace && (
              <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-600">
                <span className="font-medium">{selectedSpace.title}</span>
                <span className="text-slate-300">|</span>
                <span>知识条目 {meta?.total ?? 0}</span>
                <span className="text-slate-300">→</span>
                <span>图谱节点 —</span>
                <span className="text-slate-300">→</span>
                <span>注入次数 —</span>
              </div>
            )}
            <Card className="border-slate-200 bg-white shadow-sm">
              <CardContent className="grid gap-3 p-4 md:grid-cols-[1fr_120px_160px_160px_auto]">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setPage(1); }} className="pl-9" placeholder={selectedSpace ? `在 ${selectedSpace.title} 内做语义搜索` : '输入搜索词'} />
                </div>
                <Input value={tagFilter} onChange={(event) => { setTagFilter(event.target.value); setPage(1); }} placeholder="按标签筛选" />
                <select value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value); setPage(1); }} className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900">
                  <option value="all">全部类型</option>
                  <option value="fact">fact</option>
                  <option value="methodology">methodology</option>
                  <option value="decision">decision</option>
                  <option value="experience">experience</option>
                  <option value="meta">meta</option>
                </select>
                <div className="flex items-center rounded-md border border-slate-200 px-3 text-sm text-slate-500">
                  {selectedDirectoryId && selectedDirectoryId !== selectedSpaceId
                    ? selectedNodeHasSubdirectories ? `${selectedDirectoryTitle} · 下级知识点` : `${selectedDirectoryTitle} · 具体知识点`
                    : '空间根目录 · 全部知识点'}
                </div>
                <Button onClick={() => setEntryDialog({ mode: 'create' })} disabled={!selectedSpaceId}>
                  <FilePlus2 className="mr-2 h-4 w-4" />新建知识点
                </Button>
              </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
              <Card className="border-slate-200 bg-white shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm text-slate-900">知识点列表</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {entriesLoading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-14 animate-pulse rounded-xl bg-slate-100" />)}
                    </div>
                  ) : entries.length === 0 ? (
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">当前分类下还没有知识点。</div>
                  ) : (
                    <div className="space-y-2">
                      {entries.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => {
                            setSelectedPageId(entry.id);
                            const params = new URLSearchParams(searchParams?.toString() ?? '');
                            params.set('space', selectedSpaceId ?? '');
                            params.set('page', entry.id);
                            router.replace(`/wiki?${params.toString()}`, { scroll: false });
                          }}
                          className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${entry.id === selectedPageId ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-slate-950">{entry.title}</div>
                              <div className="mt-1 line-clamp-2 text-xs text-slate-500">{entry.summary || '暂无摘要'}</div>
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                                <Badge variant="secondary" className="text-[11px]">{entry.type}</Badge>
                                {entry.parentTitle && <span>{entry.parentTitle}</span>}
                              </div>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
                    <span>第 {meta?.page ?? 1} / {meta?.totalPages ?? 1} 页，共 {meta?.total ?? 0} 条</span>
                    <div className="flex gap-1">
                      <Button variant="outline" size="sm" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={(meta?.page ?? 1) <= 1}>
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setPage((value) => value + 1)} disabled={!meta?.totalPages || (meta?.page ?? 1) >= meta.totalPages}>
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <div className="min-h-[640px] rounded-3xl border border-slate-200 bg-white shadow-sm">
                {!selectedPageId ? (
                  <div className="flex h-full items-center justify-center p-10 text-center text-sm text-slate-500">先从左侧选择一个知识点，或直接创建新的知识点。</div>
                ) : pageError || !pageData?.data ? (
                  <ErrorState title="知识点加载失败" description={pageError?.message || '无法读取知识点详情'} />
                ) : (
                  <div className="space-y-5 p-6">
                    <div className="flex flex-col gap-4 border-b border-slate-100 pb-5 md:flex-row md:items-start md:justify-between">
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">{pageData.data.type}</Badge>
                          {pageData.data.tags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
                        </div>
                        <div>
                          <h2 className="text-2xl font-semibold text-slate-950">{pageData.data.title}</h2>
                          {pageData.data.summary && <p className="mt-2 text-sm text-slate-600">{pageData.data.summary}</p>}
                        </div>
                        <div className="flex flex-wrap gap-4 text-xs text-slate-400">
                          <span>v{pageData.data.version}</span>
                          <span>创建于 {new Date(pageData.data.createdAt).toLocaleString('zh-CN')}</span>
                          <span>更新于 {new Date(pageData.data.updatedAt).toLocaleString('zh-CN')}</span>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" onClick={() => setEntryDialog({ mode: 'edit', entry: pageData.data })}>
                          <Edit3 className="mr-2 h-4 w-4" />编辑
                        </Button>
                        <Button variant="outline" className="text-red-600" onClick={() => void deleteEntry(pageData.data)}>
                          <Trash2 className="mr-2 h-4 w-4" />删除
                        </Button>
                      </div>
                    </div>

                    <ContentRenderer content={pageData.data.content} sourceRefs={pageData.data.metadata?.extra?.sourceRefs} />

                    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-slate-900">关联知识</h3>
                        <Link
                          href={pageData.data.metadata?.extra?.graphNodeHref || `/graph?focus=${pageData.data.id}`}
                          className="text-xs font-medium text-sky-700 hover:text-sky-900"
                        >
                          在图谱中查看关系
                        </Link>
                      </div>
                      {relatedLoading ? (
                        <p className="mt-2 text-xs text-slate-500">关联知识加载中…</p>
                      ) : relatedError ? (
                        <p className="mt-2 text-xs text-red-600">关联知识加载失败：{relatedError.message}</p>
                      ) : !relatedData?.data || relatedData.data.total === 0 ? (
                        <p className="mt-2 text-xs text-slate-500">暂无关联知识（本条目在 wiki_links / 知识图谱里还没有与其他节点建立关系）。</p>
                      ) : (
                        <div className="mt-3 space-y-3">
                          {relatedData.data.groups.map((group) => (
                            <div key={group.type} className="rounded-xl border border-slate-200 bg-white p-3">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-medium text-slate-700">{group.label}</span>
                                <span className="text-[10px] text-slate-400">{group.items.length} 条</span>
                              </div>
                              <ul className="mt-2 space-y-1.5">
                                {group.items.map((item) => {
                                  const isPlaceholder = Boolean(item.placeholder);
                                  const directionLabel = item.direction === 'outgoing' ? '→' : '←';
                                  const originLabel = item.origin === 'wiki_links' ? '链接' : '图谱';
                                  return (
                                    <li key={`${item.id}-${item.direction}-${item.origin}`} className="text-xs">
                                      <span className="mr-1 text-slate-400">{directionLabel}</span>
                                      {isPlaceholder ? (
                                        <span className="text-slate-500" title={`未解析：${item.placeholder?.reason ?? 'missing'}`}>
                                          {item.title}（占位）
                                        </span>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => setSelectedPageId(item.id)}
                                          className="text-sky-700 hover:text-sky-900"
                                        >
                                          {item.title}
                                        </button>
                                      )}
                                      <span className="ml-2 text-[10px] text-slate-400">{item.knowledgeType} · {originLabel}</span>
                                      {item.summary && <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{item.summary}</p>}
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>

                    <section className="rounded-2xl border border-slate-200 bg-white p-4">
                      <h3 className="text-sm font-semibold text-slate-900">版本历史</h3>
                      <ul className="mt-2 space-y-1 text-xs text-slate-500">
                        <li className="flex items-center justify-between">
                          <span>v{pageData.data.version}（当前）</span>
                          <span>{new Date(pageData.data.updatedAt).toLocaleString('zh-CN')}</span>
                        </li>
                      </ul>
                      {pageData.data.version <= 1 && (
                        <p className="mt-2 text-xs text-slate-400">暂无历史版本，本条目仅创建了一版。</p>
                      )}
                    </section>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
