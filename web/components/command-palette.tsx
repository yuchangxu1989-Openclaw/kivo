'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import {
  BookOpen,
  Clock,
  Download,
  FileText,
  Moon,
  Network,
  Plus,
  Search,
  Sun,
  X,
} from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { apiFetch } from '@/lib/client-api';
import { typeLabel } from '@/lib/i18n-labels';
import type { ApiResponse } from '@/types';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  type: string;
  status: string;
  content: string;
  score: number;
  highlights?: string[];
}

interface CommandItem {
  id: string;
  label: string;
  icon: React.ElementType;
  action: () => void;
  keywords?: string[];
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  fact: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  decision: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  methodology: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  experience: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  intent: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  meta: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

function extractTitle(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '未命名';
  const first = trimmed.split('\n').find((l) => l.trim().length > 0) ?? trimmed;
  return first.replace(/^#+\s*/, '').length > 60
    ? `${first.replace(/^#+\s*/, '').slice(0, 60)}…`
    : first.replace(/^#+\s*/, '');
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

// ─── Component ──────────────────────────────────────────────────────────────

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  // ── Commands ────────────────────────────────────────────────────────────

  const commands: CommandItem[] = useMemo(
    () => [
      {
        id: 'cmd-new',
        label: '新建知识条目',
        icon: Plus,
        keywords: ['new', 'create', '新建', '创建'],
        action: () => {
          close();
          router.push('/knowledge/new');
        },
      },
      {
        id: 'cmd-graph',
        label: '打开图谱',
        icon: Network,
        keywords: ['graph', '图谱', '关系'],
        action: () => {
          close();
          router.push('/graph');
        },
      },
      {
        id: 'cmd-timeline',
        label: '打开时间线',
        icon: Clock,
        keywords: ['timeline', '时间线', '历史'],
        action: () => {
          close();
          router.push('/timeline');
        },
      },
      {
        id: 'cmd-search',
        label: '打开搜索',
        icon: Search,
        keywords: ['search', '搜索', '查找'],
        action: () => {
          close();
          router.push('/search');
        },
      },
      {
        id: 'cmd-knowledge',
        label: '打开知识库',
        icon: BookOpen,
        keywords: ['knowledge', '知识库', '列表'],
        action: () => {
          close();
          router.push('/knowledge');
        },
      },
      {
        id: 'cmd-export',
        label: '导出知识库',
        icon: Download,
        keywords: ['export', '导出', '下载'],
        action: () => {
          close();
          router.push('/knowledge?export=1');
        },
      },
      {
        id: 'cmd-theme',
        label: theme === 'dark' ? '切换亮色模式' : '切换暗色模式',
        icon: theme === 'dark' ? Sun : Moon,
        keywords: ['theme', 'dark', 'light', '主题', '暗色', '亮色', '深色'],
        action: () => {
          setTheme(theme === 'dark' ? 'light' : 'dark');
          close();
        },
      },
    ],
    [close, router, theme, setTheme],
  );

  // ── Filtered commands ───────────────────────────────────────────────────

  const filteredCommands = useMemo(() => {
    const q = query.trim();
    if (!q) return commands;
    return commands.filter((cmd) => {
      if (fuzzyMatch(q, cmd.label)) return true;
      return cmd.keywords?.some((kw) => fuzzyMatch(q, kw)) ?? false;
    });
  }, [commands, query]);

  // ── Search API (debounced) ──────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams({ q, pageSize: '6' });
      apiFetch<ApiResponse<SearchResult[]>>(`/api/v1/search?${params.toString()}`)
        .then((res) => {
          setSearchResults(res.data ?? []);
        })
        .catch(() => {
          setSearchResults([]);
        })
        .finally(() => {
          setSearching(false);
        });
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open]);

  // ── Combined items for keyboard navigation ─────────────────────────────

  const allItems = useMemo(() => {
    const items: Array<{ type: 'search'; result: SearchResult } | { type: 'command'; command: CommandItem }> = [];
    for (const r of searchResults) {
      items.push({ type: 'search', result: r });
    }
    for (const c of filteredCommands) {
      items.push({ type: 'command', command: c });
    }
    return items;
  }, [searchResults, filteredCommands]);

  // ── Reset on open ──────────────────────────────────────────────────────

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setSearchResults([]);
      setSearching(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // ── Clamp active index ─────────────────────────────────────────────────

  useEffect(() => {
    setActiveIndex((prev) => Math.min(prev, Math.max(0, allItems.length - 1)));
  }, [allItems.length]);

  // ── Scroll active item into view ───────────────────────────────────────

  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  // ── Execute item ───────────────────────────────────────────────────────

  const executeItem = useCallback(
    (index: number) => {
      const item = allItems[index];
      if (!item) return;
      if (item.type === 'search') {
        close();
        router.push(`/knowledge/${item.result.id}`);
      } else {
        item.command.action();
      }
    },
    [allItems, close, router],
  );

  // ── Keyboard handler ──────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((prev) => (prev + 1) % Math.max(1, allItems.length));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((prev) => (prev - 1 + allItems.length) % Math.max(1, allItems.length));
          break;
        case 'Enter':
          e.preventDefault();
          executeItem(activeIndex);
          break;
        case 'Escape':
          e.preventDefault();
          close();
          break;
      }
    },
    [activeIndex, allItems.length, close, executeItem],
  );

  if (!open) return null;

  const hasSearchResults = searchResults.length > 0;
  const hasCommands = filteredCommands.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={close}
      role="presentation"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

      {/* Panel */}
      <div
        className="relative w-full max-w-lg overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="命令面板"
        aria-modal="true"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 dark:border-slate-700">
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="搜索知识或输入命令..."
            className="h-12 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-white dark:placeholder:text-slate-500"
            aria-label="搜索知识或输入命令"
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button
              onClick={() => {
                setQuery('');
                setActiveIndex(0);
                inputRef.current?.focus();
              }}
              className="rounded-md p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              aria-label="清除搜索"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Results list */}
        <div ref={listRef} className="max-h-80 overflow-y-auto overscroll-contain py-2">
          {/* Search results section */}
          {(hasSearchResults || searching) && (
            <div>
              <div className="px-4 py-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">
                搜索结果
              </div>
              {searching && !hasSearchResults && (
                <div className="px-4 py-3 text-sm text-slate-400">搜索中...</div>
              )}
              {searchResults.map((result, i) => {
                const globalIndex = i;
                const isActive = activeIndex === globalIndex;
                return (
                  <button
                    key={result.id}
                    data-active={isActive}
                    onClick={() => executeItem(globalIndex)}
                    onMouseEnter={() => setActiveIndex(globalIndex)}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors',
                      isActive
                        ? 'bg-indigo-50 text-indigo-900 dark:bg-indigo-500/10 dark:text-indigo-200'
                        : 'text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800',
                    )}
                  >
                    <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate">{extractTitle(result.content)}</span>
                    <span
                      className={cn(
                        'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium',
                        TYPE_COLORS[result.type] ?? TYPE_COLORS.meta,
                      )}
                    >
                      {typeLabel(result.type)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Commands section */}
          {hasCommands && (
            <div>
              {hasSearchResults && <div className="my-1 border-t border-slate-100 dark:border-slate-800" />}
              <div className="px-4 py-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">
                快捷操作
              </div>
              {filteredCommands.map((cmd, i) => {
                const globalIndex = searchResults.length + i;
                const isActive = activeIndex === globalIndex;
                const Icon = cmd.icon;
                return (
                  <button
                    key={cmd.id}
                    data-active={isActive}
                    onClick={() => executeItem(globalIndex)}
                    onMouseEnter={() => setActiveIndex(globalIndex)}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors',
                      isActive
                        ? 'bg-indigo-50 text-indigo-900 dark:bg-indigo-500/10 dark:text-indigo-200'
                        : 'text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-slate-400" />
                    <span className="flex-1">{cmd.label}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Empty state */}
          {!hasSearchResults && !hasCommands && !searching && (
            <div className="px-4 py-8 text-center text-sm text-slate-400">
              没有匹配的结果
            </div>
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-4 border-t border-slate-200 px-4 py-2 text-[11px] text-slate-400 dark:border-slate-700">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px] dark:border-slate-700 dark:bg-slate-800">
              ↑↓
            </kbd>
            导航
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px] dark:border-slate-700 dark:bg-slate-800">
              ↵
            </kbd>
            执行
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px] dark:border-slate-700 dark:bg-slate-800">
              esc
            </kbd>
            关闭
          </span>
        </div>
      </div>
    </div>
  );
}
