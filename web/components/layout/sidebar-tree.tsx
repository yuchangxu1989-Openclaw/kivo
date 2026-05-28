'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, CircleDashed, FolderTree, GitBranch, Layers3, ListFilter, Radio } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/components/ui/utils';
import { BASE_PATH, apiFetch } from '@/lib/client-api';
import type { ApiResponse } from '@/types';
import type { SubjectTreeNode } from '@/lib/types/subject';

type SidebarTreeProps = {
  onNavigate?: () => void;
  selectedSubjectId?: string | null;
  onSelect?: (subjectId: string) => void;
};

type StaticTreeNode = {
  label: string;
  href: string;
  count?: string;
  children?: StaticTreeNode[];
};

const EXPANDED_STORAGE_KEY = 'kivo-tree-expanded';

const sceneTree: StaticTreeNode[] = [
  {
    label: '场景树占位',
    href: '/intent',
    count: '待接 API',
    children: [
      { label: '研发流程纠偏', href: '/intent?scene=dev-process', count: '—' },
      { label: '汇报风格偏好', href: '/intent?scene=communication', count: '—' },
      { label: '调度与任务闭环', href: '/intent?scene=dispatch', count: '—' },
      { label: '故障排查经验', href: '/intent?scene=debugging', count: '—' },
    ],
  },
];

const researchFilters: StaticTreeNode[] = [
  { label: '全部调研', href: '/research', count: '—' },
  { label: '进行中', href: '/research?status=running', count: '—' },
  { label: '已完成', href: '/research?status=done', count: '—' },
  { label: '已采纳', href: '/research?status=adopted', count: '—' },
  { label: '已否决', href: '/research?status=rejected', count: '—' },
];

function normalizePathname(pathname: string | null) {
  if (!pathname) return '/';
  return pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) || '/' : pathname;
}

function getRail(pathname: string) {
  if (pathname === '/research' || pathname.startsWith('/research/')) {
    return {
      kind: 'static' as const,
      title: '调研状态',
      helper: 'Web 只查看和采纳，调研仍从 IM 发起。',
      icon: ListFilter,
      nodes: researchFilters,
    };
  }

  if (pathname === '/intent' || pathname.startsWith('/intent/') || pathname === '/knowledge' || pathname.startsWith('/knowledge/')) {
    return {
      kind: 'static' as const,
      title: '场景树',
      helper: '意图知识按任务场景组织，B1 接口完成后换成真实数据。',
      icon: GitBranch,
      nodes: sceneTree,
      action: { href: '/graph', label: '知识图谱' },
    };
  }

  return {
    kind: 'subject' as const,
    title: '学科树',
    helper: '原始资料库和领域 wiki 共用同一棵学科树。',
    icon: FolderTree,
    action: pathname === '/wiki' || pathname.startsWith('/wiki/') ? { href: '/graph', label: '知识图谱' } : undefined,
  };
}

function StaticTreeLink({ node, level = 0, activePath, onNavigate }: { node: StaticTreeNode; level?: number; activePath: string; onNavigate?: () => void }) {
  const active = activePath === node.href || (node.href !== '/' && activePath.startsWith(`${node.href}/`));
  const hasChildren = Boolean(node.children?.length);

  return (
    <div>
      <Link
        href={node.href}
        onClick={onNavigate}
        className={cn(
          'flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors',
          active ? 'bg-slate-100 font-semibold text-slate-900 ring-1 ring-slate-200' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-950'
        )}
        style={{ paddingLeft: `${12 + level * 14}px` }}
      >
        {hasChildren ? <ChevronRight className="h-3.5 w-3.5 text-slate-400" /> : <CircleDashed className="h-3.5 w-3.5 text-slate-300" />}
        <span className="min-w-0 flex-1">{node.label}</span>
        {node.count && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">{node.count}</span>}
      </Link>
      {node.children?.map((child) => (
        <StaticTreeLink key={child.href} node={child} level={level + 1} activePath={activePath} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

function readExpandedState() {
  if (typeof window === 'undefined') return new Set<string>();
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (!raw) return new Set<string>();
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? new Set(ids.filter((id): id is string => typeof id === 'string')) : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

function collectExpandableIds(nodes: SubjectTreeNode[]) {
  const ids: string[] = [];
  const walk = (items: SubjectTreeNode[]) => {
    for (const item of items) {
      if (item.children.length > 0) ids.push(item.id);
      walk(item.children);
    }
  };
  walk(nodes);
  return ids;
}

function SubjectTreeLink({
  node,
  level = 0,
  expanded,
  selectedSubjectId,
  onToggle,
  onSelect,
  onNavigate,
}: {
  node: SubjectTreeNode;
  level?: number;
  expanded: Set<string>;
  selectedSubjectId?: string | null;
  onToggle: (subjectId: string) => void;
  onSelect?: (subjectId: string) => void;
  onNavigate?: () => void;
}) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.id);
  const selected = selectedSubjectId === node.id;

  const selectNode = () => {
    onSelect?.(node.id);
    onNavigate?.();
  };

  return (
    <div data-subject-level={node.level}>
      <div
        className={cn(
          'flex items-center gap-1 rounded-xl px-2 py-1.5 text-sm transition-colors',
          selected ? 'bg-slate-100 font-semibold text-slate-900 ring-1 ring-slate-200' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-950'
        )}
        style={{ paddingLeft: `${8 + level * 14}px` }}
      >
        <button
          type="button"
          onClick={() => hasChildren && onToggle(node.id)}
          className={cn('rounded-md p-1 text-slate-400 hover:bg-white hover:text-slate-700', !hasChildren && 'pointer-events-none opacity-60')}
          aria-label={hasChildren ? `${isExpanded ? '收起' : '展开'}${node.name}` : `${node.name}无子节点`}
          aria-expanded={hasChildren ? isExpanded : undefined}
        >
          {hasChildren ? <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-90')} /> : <CircleDashed className="h-3.5 w-3.5 text-slate-300" />}
        </button>
        <button
          type="button"
          onClick={selectNode}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 text-left"
          aria-current={selected ? 'true' : undefined}
          data-subject-id={node.id}
        >
          <span className="min-w-0 flex-1">{node.name}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">{node.materialCount}</span>
        </button>
      </div>
      {hasChildren && isExpanded && (
        <div>
          {node.children.map((child) => (
            <SubjectTreeLink
              key={child.id}
              node={child}
              level={level + 1}
              expanded={expanded}
              selectedSubjectId={selectedSubjectId}
              onToggle={onToggle}
              onSelect={onSelect}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SubjectTreePanel({ selectedSubjectId, onSelect, onNavigate }: SidebarTreeProps) {
  const [subjects, setSubjects] = useState<SubjectTreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setExpanded(readExpandedState());
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<ApiResponse<SubjectTreeNode[]>>('/api/subjects')
      .then((payload) => {
        if (cancelled) return;
        const nextSubjects = payload.data ?? [];
        setSubjects(nextSubjects);
        setExpanded((current) => {
          if (current.size > 0) return current;
          return new Set(collectExpandableIds(nextSubjects));
        });
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '学科树加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(expanded)));
  }, [expanded]);

  const total = useMemo(() => {
    let n = 0;
    const walk = (items: SubjectTreeNode[]) => {
      for (const item of items) {
        n += 1;
        walk(item.children);
      }
    };
    walk(subjects);
    return n;
  }, [subjects]);

  const toggle = (subjectId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(subjectId)) next.delete(subjectId);
      else next.add(subjectId);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="space-y-2 p-1" aria-label="学科树加载中">
        {Array.from({ length: 7 }).map((_, index) => (
          <div key={index} className="h-8 animate-pulse rounded-xl bg-slate-100" />
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="rounded-2xl border border-red-100 bg-red-50 p-3 text-xs leading-5 text-red-700">学科树加载失败：{error}</div>;
  }

  if (subjects.length === 0) {
    return <div className="rounded-2xl bg-slate-50 p-3 text-xs leading-5 text-slate-500">还没有学科域。</div>;
  }

  return (
    <div className="space-y-1" data-subject-tree-total={total}>
      {subjects.map((node) => (
        <SubjectTreeLink
          key={node.id}
          node={node}
          expanded={expanded}
          selectedSubjectId={selectedSubjectId}
          onToggle={toggle}
          onSelect={onSelect}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}

export function SidebarTree({ onNavigate, selectedSubjectId, onSelect }: SidebarTreeProps) {
  const pathname = normalizePathname(usePathname());
  const rail = getRail(pathname);
  const RailIcon = rail.icon;

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 p-4">
        <div className="flex items-center gap-2 text-sm font-black text-slate-950">
          <RailIcon className="h-4 w-4 text-slate-800" />
          {rail.title}
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-500">{rail.helper}</p>
        {rail.action && (
          <Link
            href={rail.action.href}
            onClick={onNavigate}
            className="mt-3 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-200"
          >
            <Layers3 className="h-3.5 w-3.5" />
            {rail.action.label}
          </Link>
        )}
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto p-3">
        {rail.kind === 'subject' ? (
          <SubjectTreePanel selectedSubjectId={selectedSubjectId} onSelect={onSelect} onNavigate={onNavigate} />
        ) : (
          rail.nodes.map((node) => <StaticTreeLink key={node.href} node={node} activePath={pathname} onNavigate={onNavigate} />)
        )}
      </div>

      <div className="border-t border-slate-200 p-4">
        <div className="rounded-2xl bg-slate-50 p-3 text-xs leading-5 text-slate-500">
          <div className="mb-1 flex items-center gap-2 font-semibold text-slate-700">
            <Radio className="h-3.5 w-3.5 text-emerald-600" />
            学科数据
          </div>
          学科树来自 subjects API，展开状态保存在本机浏览器。
        </div>
      </div>
    </aside>
  );
}
