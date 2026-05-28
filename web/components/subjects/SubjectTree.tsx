'use client';

import * as React from 'react';
import { ChevronRight, Pencil, RefreshCw, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState } from '@/components/ui/page-states';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/components/ui/utils';
import { apiFetch } from '@/lib/client-api';
import type { ApiResponse } from '@/types';

export interface SubjectTreeNodeData {
  id: string;
  parent_id?: string | null;
  parentId?: string | null;
  name: string;
  level?: number;
  materialCount?: number;
  children?: SubjectTreeNodeData[];
}

export interface SubjectTreeProps {
  selectedId?: string;
  onSelect?: (node: SubjectTreeNodeData) => void;
  onRename?: (node: SubjectTreeNodeData) => void;
  onDelete?: (node: SubjectTreeNodeData) => void;
  className?: string;
  storageKey?: string;
  initialTree?: SubjectTreeNodeData[];
}

const DEFAULT_STORAGE_KEY = 'kivo.subject-tree.expanded';

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

function parentOf(node: SubjectTreeNodeData) {
  return node.parentId ?? node.parent_id ?? null;
}

export function buildSubjectTree(nodes: SubjectTreeNodeData[]): SubjectTreeNodeData[] {
  if (nodes.some((node) => Array.isArray(node.children) && node.children.length > 0)) {
    return nodes;
  }

  const cloned = nodes.map((node) => ({ ...node, children: [] as SubjectTreeNodeData[] }));
  const byId = new Map(cloned.map((node) => [node.id, node]));
  const roots: SubjectTreeNodeData[] = [];

  for (const node of cloned) {
    const parentId = parentOf(node);
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function collectNodeIds(nodes: SubjectTreeNodeData[], out: string[] = []) {
  for (const node of nodes) {
    out.push(node.id);
    if (node.children?.length) collectNodeIds(node.children, out);
  }
  return out;
}

function readExpanded(storageKey: string, fallback: string[]) {
  if (typeof window === 'undefined') return new Set(fallback);
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set(fallback);
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : fallback);
  } catch {
    return new Set(fallback);
  }
}

function writeExpanded(storageKey: string, expanded: Set<string>) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey, JSON.stringify([...expanded]));
}

export function SubjectTree({
  selectedId,
  onSelect,
  onRename,
  onDelete,
  className,
  storageKey = DEFAULT_STORAGE_KEY,
  initialTree,
}: SubjectTreeProps) {
  const [tree, setTree] = React.useState<SubjectTreeNodeData[]>(() => buildSubjectTree(initialTree ?? []));
  const [state, setState] = React.useState<LoadState>(initialTree ? 'loaded' : 'idle');
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(() => readExpanded(storageKey, []));

  const loadSubjects = React.useCallback(async () => {
    if (initialTree) return;
    setState('loading');
    setError(null);
    try {
      const response = await apiFetch<ApiResponse<SubjectTreeNodeData[]>>('/api/subjects/list');
      const data = response.data ?? [];
      const nextTree = buildSubjectTree(data);
      setTree(nextTree);
      setExpanded((current) => {
        if (current.size > 0) return current;
        return readExpanded(storageKey, collectNodeIds(nextTree).filter((id) => nextTree.some((node) => node.id === id)));
      });
      setState('loaded');
    } catch (err) {
      setError(err instanceof Error ? err.message : '学科域加载失败');
      setState('error');
    }
  }, [initialTree, storageKey]);

  React.useEffect(() => {
    void loadSubjects();
  }, [loadSubjects]);

  React.useEffect(() => {
    writeExpanded(storageKey, expanded);
  }, [expanded, storageKey]);

  const toggle = React.useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (state === 'loading' || state === 'idle') return <SubjectTreeSkeleton className={className} />;
  if (state === 'error') {
    return (
      <ErrorState
        className={className}
        title="学科域加载失败"
        description={error ?? '请稍后重试。'}
        onRetry={loadSubjects}
      />
    );
  }
  if (tree.length === 0) {
    return (
      <EmptyState
        className={className}
        title="还没有学科域"
        description="导入资料并完成识别后，KIVO 会在这里显示学科域树。"
      />
    );
  }

  return (
    <div className={cn('rounded-xl border border-slate-200 bg-white/95 p-2 shadow-sm', className)}>
      <div role="tree" aria-label="学科域树" className="space-y-1">
        {tree.map((node) => (
          <SubjectTreeNode
            key={node.id}
            node={node}
            depth={0}
            selectedId={selectedId}
            expanded={expanded}
            onToggle={toggle}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  );
}

function SubjectTreeNode({
  node,
  depth,
  selectedId,
  expanded,
  onToggle,
  onSelect,
  onRename,
  onDelete,
}: {
  node: SubjectTreeNodeData;
  depth: number;
  selectedId?: string;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect?: (node: SubjectTreeNodeData) => void;
  onRename?: (node: SubjectTreeNodeData) => void;
  onDelete?: (node: SubjectTreeNodeData) => void;
}) {
  const children = node.children ?? [];
  const hasChildren = children.length > 0;
  const isExpanded = expanded.has(node.id);
  const selected = selectedId === node.id;

  return (
    <div>
      <div
        role="treeitem"
        aria-selected={selected}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-level={depth + 1}
        className={cn(
          'group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm outline-none transition-colors',
          selected ? 'bg-slate-100 text-slate-950 ring-1 ring-slate-200' : 'text-slate-700 hover:bg-slate-50',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <button
          type="button"
          aria-label={hasChildren ? `${isExpanded ? '收起' : '展开'} ${node.name}` : `${node.name} 没有子节点`}
          disabled={!hasChildren}
          onClick={() => hasChildren && onToggle(node.id)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-30"
        >
          <ChevronRight className={cn('h-4 w-4 transition-transform', isExpanded && 'rotate-90')} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onSelect?.(node)}
          className="min-w-0 flex-1 rounded px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={node.name}
        >
          {node.name}
        </button>
        {typeof node.materialCount === 'number' && (
          <Badge variant="outline" className="shrink-0 border-slate-200 bg-slate-50 text-slate-500">
            {node.materialCount}
          </Badge>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`重命名学科域：${node.name}`}
          onClick={() => onRename?.(node)}
          className="h-7 w-7 shrink-0 opacity-70 hover:opacity-100"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`删除学科域：${node.name}`}
          onClick={() => onDelete?.(node)}
          className="h-7 w-7 shrink-0 text-red-600 opacity-70 hover:text-red-700 hover:opacity-100"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      {hasChildren && isExpanded && (
        <div role="group" className="space-y-1">
          {children.map((child) => (
            <SubjectTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SubjectTreeSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-2 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm', className)} aria-label="学科域树加载中">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
        加载学科域...
      </div>
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className={cn('h-8 rounded-lg', index % 2 === 1 && 'ml-6 w-4/5')} />
      ))}
    </div>
  );
}
