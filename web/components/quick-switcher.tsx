'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Clock3, FileText, Search, X } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { useApi } from '@/hooks/use-api';
import type { ApiResponse } from '@/types';
import { TYPE_LABELS, typeLabel } from '@/lib/i18n-labels';

interface KnowledgeEntry {
  id: string;
  type: string;
  status: string;
  content: string;
  updatedAt: string;
}

const TYPE_COLORS: Record<string, string> = {
  fact: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  decision: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  methodology: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  experience: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  intent: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  meta: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

const RECENT_KEY = 'kivo-quick-switcher-recent';
const MAX_RECENT = 10;

function getRecentIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function addRecentId(id: string) {
  const ids = getRecentIds().filter((i) => i !== id);
  ids.unshift(id);
  localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, MAX_RECENT)));
}

function extractTitle(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '未命名';
  const first = trimmed.split('\n').find((l) => l.trim().length > 0) ?? trimmed;
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

function extractPreview(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 50 ? `${compact.slice(0, 50)}…` : compact;
}

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(dateStr).toLocaleDateString('zh-CN');
}

interface QuickSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function QuickSwitcher({ open, onOpenChange }: QuickSwitcherProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const { data } = useApi<ApiResponse<{ items: KnowledgeEntry[] }>>(
    open ? '/api/v1/knowledge?pageSize=50&sort=-updatedAt' : null,
  );

  const entries = data?.data?.items ?? [];

  const results = useMemo(() => {
    const recentIds = getRecentIds();
    const q = query.trim();

    if (!q) {
      // Show recent entries first, then the rest by updatedAt
      const recentSet = new Set(recentIds);
      const recentEntries = recentIds
        .map((id) => entries.find((e) => e.id === id))
        .filter((e): e is KnowledgeEntry => !!e);
      const rest = entries.filter((e) => !recentSet.has(e.id));
      return [
        ...recentEntries.map((e) => ({ entry: e, isRecent: true })),
        ...rest.slice(0, 20).map((e) => ({ entry: e, isRecent: false })),
      ];
    }

    // Fuzzy search on title + first 50 chars of content
    const matched = entries.filter((e) => {
      const title = extractTitle(e.content);
      const preview = extractPreview(e.content);
      return fuzzyMatch(q, title) || fuzzyMatch(q, preview);
    });

    // Boost recent entries to the top
    const recentSet = new Set(recentIds);
    matched.sort((a, b) => {
      const aRecent = recentSet.has(a.id) ? 0 : 1;
      const bRecent = recentSet.has(b.id) ? 0 : 1;
      if (aRecent !== bRecent) return aRecent - bRecent;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    return matched.slice(0, 30).map((e) => ({ entry: e, isRecent: recentSet.has(e.id) }));
  }, [entries, query]);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Focus input after mount
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep activeIndex in bounds
  useEffect(() => {
    if (activeIndex >= results.length) {
      setActiveIndex(Math.max(0, results.length - 1));
    }
  }, [results.length, activeIndex]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector('[data-active="true"]');
    if (active) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const handleSelect = useCallback(
    (id: string) => {
      addRecentId(id);
      onOpenChange(false);
      router.push(`/knowledge/${id}`);
    },
    [router, onOpenChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((i) => (i < results.length - 1 ? i + 1 : 0));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((i) => (i > 0 ? i - 1 : results.length - 1));
          break;
        case 'Enter':
          e.preventDefault();
          if (results[activeIndex]) {
            handleSelect(results[activeIndex].entry.id);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onOpenChange(false);
          break;
      }
    },
    [results, activeIndex, handleSelect, onOpenChange],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      onClick={() => onOpenChange(false)}
      role="presentation"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative z-10 w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="快速切换器"
        aria-modal="true"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 dark:border-slate-700">
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            type="text"
            className="h-12 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-white dark:placeholder:text-slate-500"
            placeholder="搜索知识条目…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            aria-label="搜索知识条目"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
            onClick={() => onOpenChange(false)}
            aria-label="关闭快速切换器"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          className="max-h-[50vh] overflow-y-auto overscroll-contain"
          role="listbox"
          aria-label="搜索结果"
        >
          {results.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-sm text-slate-400">
              <FileText className="h-8 w-8" />
              <span>{query ? '没有匹配的知识条目' : '暂无知识条目'}</span>
            </div>
          ) : (
            results.map(({ entry, isRecent }, index) => (
              <button
                key={entry.id}
                data-active={index === activeIndex}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
                  index === activeIndex
                    ? 'bg-indigo-50 dark:bg-indigo-950/40'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
                )}
                onClick={() => handleSelect(entry.id)}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
                aria-selected={index === activeIndex}
              >
                {isRecent && !query && (
                  <Clock3 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                )}
                {(!isRecent || !!query) && (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                )}

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900 dark:text-white">
                    {extractTitle(entry.content)}
                  </div>
                </div>

                <span
                  className={cn(
                    'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium',
                    TYPE_COLORS[entry.type] ?? TYPE_COLORS.meta,
                  )}
                >
                  {TYPE_LABELS[entry.type] ?? entry.type}
                </span>

                <span className="shrink-0 text-[11px] text-slate-400">
                  {formatRelativeTime(entry.updatedAt)}
                </span>
              </button>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-4 border-t border-slate-200 px-4 py-2 text-[11px] text-slate-400 dark:border-slate-700">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px] dark:border-slate-700 dark:bg-slate-800">↑↓</kbd>
            导航
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px] dark:border-slate-700 dark:bg-slate-800">↵</kbd>
            打开
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px] dark:border-slate-700 dark:bg-slate-800">esc</kbd>
            关闭
          </span>
        </div>
      </div>
    </div>
  );
}
