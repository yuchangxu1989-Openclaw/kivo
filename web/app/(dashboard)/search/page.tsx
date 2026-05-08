'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  History,
  Lightbulb,
  Search as SearchIcon,
  Sparkles,
  MoreHorizontal,
  ExternalLink,
  Network,
  Link2,
  Clock,
  Check,
  Tag,
  X,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState, ErrorState, ResultsSkeleton } from '@/components/ui/page-states';
import { typeLabel, statusLabel } from '@/lib/i18n-labels';
import type { ApiResponse } from '@/types';
import { useCognitiveMode } from '@/contexts/cognitive-mode-context';
import { CognitivePanel } from '@/components/cognitive-panel';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  type: string;
  status: string;
  content: string;
  score: number;
  createdAt?: string;
  highlights?: string[];
  metadata?: { tags?: string[] };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const EXAMPLE_QUERIES = ['架构评审规则', '最近的运维经验', '冲突裁决流程', '知识状态定义'];

const KNOWLEDGE_TYPE_CHIPS = [
  { value: 'all-types', label: '全部', color: '' },
  { value: 'fact', label: '事实', color: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700' },
  { value: 'decision', label: '决策', color: 'bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-700' },
  { value: 'methodology', label: '方法论', color: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700' },
  { value: 'experience', label: '经验', color: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-700' },
  { value: 'intent', label: '意图', color: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700' },
  { value: 'meta', label: '元知识', color: 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-900/40 dark:text-gray-300 dark:border-gray-700' },
];

const TIME_RANGE_OPTIONS = [
  { value: 'all', label: '全部时间' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: '90d', label: '近 90 天' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Highlight matching keywords in text with <mark> tags */
function highlightText(text: string, query: string): string {
  if (!query.trim()) return escapeHtml(text);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  return escapeHtml(text).replace(regex, '<mark class="rounded-sm bg-amber-200 dark:bg-amber-700 dark:text-amber-100 px-0.5">$1</mark>');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Extract context snippet around the first match (±60 chars) */
function extractContextSnippet(content: string, query: string): string {
  if (!query.trim()) return content.slice(0, 120);
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerContent.indexOf(lowerQuery);
  if (idx === -1) return content.slice(0, 120);
  const start = Math.max(0, idx - 60);
  const end = Math.min(content.length, idx + query.length + 60);
  let snippet = '';
  if (start > 0) snippet += '…';
  snippet += content.slice(start, end);
  if (end < content.length) snippet += '…';
  return snippet;
}

const SEARCH_HISTORY_KEY = 'kivo-search-history';
const MAX_HISTORY = 10;

function getSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function addSearchHistory(term: string) {
  const history = getSearchHistory().filter((h) => h !== term);
  history.unshift(term);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
}

function removeSearchHistoryItem(term: string) {
  const history = getSearchHistory().filter((h) => h !== term);
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
}

// ─── Page Component ─────────────────────────────────────────────────────────

export default function SearchPage() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [type, setType] = useState('all-types');
  const [status, setStatus] = useState('all-statuses');
  const [timeRange, setTimeRange] = useState('all');
  const [minConfidence, setMinConfidence] = useState(0);
  const [tagsInput, setTagsInput] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [activeResultIndex, setActiveResultIndex] = useState(-1);
  const [activeHistoryIndex, setActiveHistoryIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const { isFocus } = useCognitiveMode();
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSearchHistory(getSearchHistory());
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Parse tags from comma-separated input
  const filterTags = useMemo(() => {
    return tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }, [tagsInput]);

  const params = useMemo(() => {
    if (!submitted) return null;
    const search = new URLSearchParams();
    search.set('q', submitted);
    search.set('pageSize', '20');
    if (type !== 'all-types') search.set('type', type);
    if (status !== 'all-statuses') search.set('status', status);
    return `/api/v1/search?${search.toString()}`;
  }, [submitted, type, status]);

  const { data, isLoading, error, mutate } = useApi<ApiResponse<SearchResult[]>>(params);

  // Fetch recent items for empty state
  const { data: recentData } = useApi<ApiResponse<SearchResult[]>>(
    !submitted ? '/api/v1/knowledge?pageSize=10&sort=-updatedAt' : null,
  );

  // Client-side filtering for time range, confidence, and tags
  const results = useMemo(() => {
    const raw = data?.data ?? [];
    let filtered = raw;

    // Filter by confidence
    if (minConfidence > 0) {
      filtered = filtered.filter((r) => r.score * 100 >= minConfidence);
    }

    // Filter by time range
    if (timeRange !== 'all') {
      const now = Date.now();
      const ms =
        timeRange === '7d'
          ? 7 * 86400000
          : timeRange === '30d'
            ? 30 * 86400000
            : timeRange === '90d'
              ? 90 * 86400000
              : 0;
      if (ms > 0) {
        filtered = filtered.filter((r) => {
          const created = r.createdAt ? new Date(r.createdAt).getTime() : 0;
          return now - created <= ms;
        });
      }
    }

    // Filter by tags
    if (filterTags.length > 0) {
      filtered = filtered.filter((r) => {
        const itemTags = r.metadata?.tags ?? [];
        return filterTags.some((ft) => itemTags.includes(ft));
      });
    }

    return filtered;
  }, [data, minConfidence, timeRange, filterTags]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (query.trim()) {
        const term = query.trim();
        setSubmitted(term);
        addSearchHistory(term);
        setSearchHistory(getSearchHistory());
        setShowHistory(false);
        setActiveResultIndex(-1);
      }
    },
    [query],
  );

  const handleCopyLink = useCallback(
    (id: string) => {
      const url = `${window.location.origin}/knowledge/${id}`;
      navigator.clipboard.writeText(url).then(() => {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      });
    },
    [],
  );

  const handleViewInGraph = useCallback(
    (id: string) => {
      router.push(`/graph?focus=${id}`);
    },
    [router],
  );

  const handleHistorySelect = useCallback((term: string) => {
    setQuery(term);
    setSubmitted(term);
    addSearchHistory(term);
    setSearchHistory(getSearchHistory());
    setShowHistory(false);
    setActiveHistoryIndex(-1);
    setActiveResultIndex(-1);
  }, []);

  const handleRemoveHistory = useCallback((term: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeSearchHistoryItem(term);
    setSearchHistory(getSearchHistory());
  }, []);

  useEffect(() => {
    setActiveResultIndex(-1);
  }, [results]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // History dropdown keyboard navigation
      if (showHistory && searchHistory.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActiveHistoryIndex((prev) => (prev < searchHistory.length - 1 ? prev + 1 : 0));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActiveHistoryIndex((prev) => (prev > 0 ? prev - 1 : searchHistory.length - 1));
        } else if (e.key === 'Enter' && activeHistoryIndex >= 0 && !(e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) {
          e.preventDefault();
          const term = searchHistory[activeHistoryIndex];
          if (term) handleHistorySelect(term);
        } else if (e.key === 'Escape') {
          setShowHistory(false);
          setActiveHistoryIndex(-1);
        }
        return;
      }
      if (!results.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveResultIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveResultIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
      } else if (e.key === 'Enter' && activeResultIndex >= 0 && !(e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) {
        e.preventDefault();
        const target = results[activeResultIndex];
        if (target) router.push(`/knowledge/${target.id}`);
      }
    },
    [results, activeResultIndex, showHistory, searchHistory, activeHistoryIndex, router, handleHistorySelect],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950 dark:text-slate-50">语义搜索</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          直接输入问题、规则名称或一段自然语言。系统会按语义相关性返回条目，并给出命中高亮片段与相关度评分。
        </p>
      </div>

      {/* Search form */}
      <div className="rounded-[28px] border border-slate-200/80 bg-white/95 p-5 shadow-sm sm:p-6 dark:border-slate-700 dark:bg-slate-900/95" onKeyDown={handleKeyDown}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex flex-col gap-3 xl:flex-row">
            <div className="relative flex-1" ref={historyRef}>
              <SearchIcon className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                className="h-12 rounded-2xl border-slate-200 bg-slate-50 pl-11 pr-4 text-base shadow-sm dark:border-slate-700 dark:bg-slate-800"
                placeholder={'例如：搜索"架构评审规则"或"最近的运维经验"'}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => { if (!query && searchHistory.length > 0) { setShowHistory(true); setActiveHistoryIndex(-1); } }}
                aria-label="输入搜索问题"
              />
              {showHistory && searchHistory.length > 0 && !query && !isFocus && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
                  <div className="flex items-center justify-between px-4 py-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><History className="h-3 w-3" />搜索历史</span>
                    <span className="text-[10px]">↑↓ 选择 · Enter 确认</span>
                  </div>
                  {searchHistory.map((term, idx) => (
                    <button
                      key={term}
                      type="button"
                      className={`flex w-full items-center justify-between px-4 py-2 text-sm transition-colors ${idx === activeHistoryIndex ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300' : 'text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                      onClick={() => handleHistorySelect(term)}
                    >
                      <span className="truncate">{term}</span>
                      <X
                        className="h-3.5 w-3.5 shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                        onClick={(e) => handleRemoveHistory(term, e)}
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-12 xl:w-[160px]" aria-label="按知识状态过滤搜索结果">
                <SelectValue placeholder="全部状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all-statuses">全部状态</SelectItem>
                <SelectItem value="active">活跃</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="submit"
              disabled={!query.trim()}
              className="h-12 rounded-2xl px-6 text-base font-semibold xl:min-w-[132px]"
            >
              搜索知识
            </Button>
          </div>

          {/* Type pill chips — hidden in Focus mode */}
          {!isFocus && (
          <div className="flex flex-wrap items-center gap-2">
            {KNOWLEDGE_TYPE_CHIPS.map((chip) => {
              const isActive = type === chip.value;
              return (
                <button
                  key={chip.value}
                  type="button"
                  onClick={() => {
                    setType(chip.value);
                  }}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    isActive
                      ? chip.value === 'all-types'
                        ? 'border-indigo-300 bg-indigo-100 text-indigo-800 dark:border-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300'
                        : chip.color
                      : 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
                  }`}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
          )}
          <div className={`flex flex-wrap items-center gap-4 text-sm ${isFocus ? 'hidden' : ''}`}>
            {/* Time range */}
            <div className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-slate-400" />
              <div className="flex rounded-lg border border-slate-200 overflow-hidden dark:border-slate-700">
                {TIME_RANGE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setTimeRange(opt.value)}
                    className={`px-3 py-1 text-xs transition-colors ${
                      timeRange === opt.value
                        ? 'bg-indigo-50 text-indigo-700 font-medium dark:bg-indigo-900/40 dark:text-indigo-300'
                        : 'text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Confidence slider */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 dark:text-slate-400">置信度 ≥</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={minConfidence}
                onChange={(e) => setMinConfidence(parseInt(e.target.value))}
                className="h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-slate-200 accent-indigo-600 dark:bg-slate-700"
                aria-label="最低置信度"
              />
              <span className="w-8 text-xs font-medium text-slate-700 dark:text-slate-300">{minConfidence}%</span>
            </div>

            {/* Tags input */}
            <div className="flex items-center gap-2">
              <Tag className="h-3.5 w-3.5 text-slate-400" />
              <Input
                className="h-7 w-48 text-xs"
                placeholder="标签筛选（逗号分隔）"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                aria-label="按标签筛选"
              />
            </div>

            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
              <span className="text-xs">支持按规则、经验、决策、异常处理记录进行语义检索。</span>
            </div>
          </div>
        </form>
      </div>

      {/* First-use guidance / Recent items when no search */}
      {!submitted && (
        <div className="space-y-6">
          <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-[28px] border border-slate-200/80 bg-white/95 p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900/95">
              <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400">
                <Lightbulb className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-[0.2em]">首用引导</span>
              </div>
              <h2 className="mt-3 text-xl font-semibold text-slate-950 dark:text-slate-50">先从这些问题开始</h2>
              <div className="mt-5 flex flex-wrap gap-3">
                {EXAMPLE_QUERIES.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      setQuery(item);
                      setSubmitted(item);
                    }}
                    className="rounded-full border border-indigo-100 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 transition-colors hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300 dark:hover:bg-indigo-900/50"
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-[28px] border border-slate-200/80 bg-slate-950 p-6 text-white shadow-sm dark:border-slate-700">
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-sky-200">搜索范围</p>
              <div className="mt-3 space-y-3 text-sm leading-6 text-slate-300">
                <p>可搜索知识正文、命中高亮片段、条目类型与状态。</p>
                <p>
                  如果没有结果，换成更具体的业务词、规则名或最近处理过的异常描述，命中率会更高。
                </p>
                <p>搜索结果会按相关度排序，右侧会显示匹配分数。</p>
              </div>
            </div>
          </div>

          {/* Recent items */}
          {recentData?.data && recentData.data.length > 0 && (
            <div className="rounded-[28px] border border-slate-200/80 bg-white/95 p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900/95">
              <div className="flex items-center gap-2 mb-4">
                <Clock className="h-4 w-4 text-slate-400" />
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">最近修改</h3>
              </div>
              <div className="space-y-2">
                {recentData.data.slice(0, 10).map((item) => (
                  <Link
                    key={item.id}
                    href={`/knowledge/${item.id}`}
                    className="flex items-center justify-between rounded-xl px-4 py-2.5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-slate-800 dark:text-slate-200">
                        {item.content.split('\n')[0]?.slice(0, 80) || '未命名'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      <Badge variant="outline" className="text-[10px]">
                        {typeLabel(item.type)}
                      </Badge>
                      {item.createdAt && (
                        <span className="text-[11px] text-muted-foreground">
                          {new Date(item.createdAt).toLocaleDateString('zh-CN')}
                        </span>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error state */}
      {error && submitted && (
        <ErrorState
          title="搜索请求失败"
          description={error.message || '暂时拿不到搜索结果，请稍后再试。'}
          onRetry={() => void mutate()}
        />
      )}

      {/* Loading */}
      {isLoading && <ResultsSkeleton rows={3} />}

      {/* Empty results */}
      {submitted && !isLoading && !error && results.length === 0 && (
        <EmptyState
          icon={SearchIcon}
          title={`未找到与"${submitted}"相关的结果`}
          description={'试试换成更明确的规则名、角色名或操作场景，比如"架构评审规则""运维经验""冲突裁决流程"。'}
          primaryAction={{ label: '查看知识库', href: '/knowledge' }}
          secondaryAction={{ label: '去活动流找线索', href: '/activity', variant: 'outline' }}
        />
      )}

      {/* Results list */}
      {!error && results.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            找到 {data?.meta?.total ?? results.length} 条结果
            {minConfidence > 0 && (
              <span className="ml-1">
                （置信度 ≥ {minConfidence}% 过滤后 {results.length} 条）
              </span>
            )}
            <span className="ml-2 text-xs text-slate-400">↑↓ 导航 · Enter 打开</span>
          </p>
          {results.map((result, idx) => (
            <div
              key={result.id}
              className={`group relative rounded-[24px] border p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md dark:hover:border-indigo-700 ${idx === activeResultIndex ? 'border-indigo-300 bg-indigo-50/50 ring-2 ring-indigo-200 dark:border-indigo-600 dark:bg-indigo-950/30 dark:ring-indigo-800' : 'border-slate-200 bg-white/95 dark:border-slate-700 dark:bg-slate-900/95'}`}
            >
              <div className="flex items-start justify-between gap-3">
                <Link
                  href={`/knowledge/${result.id}`}
                  className="min-w-0 flex-1 space-y-2"
                >
                  {/* Content with keyword highlighting and context snippet */}
                  {result.highlights?.length ? (
                    <p
                      className="text-sm leading-6 text-slate-800 dark:text-slate-200 [&_mark]:rounded-sm [&_mark]:bg-amber-200 [&_mark]:px-1 dark:[&_mark]:bg-amber-700 dark:[&_mark]:text-amber-100"
                      dangerouslySetInnerHTML={{ __html: highlightText(result.highlights[0].replace(/<[^>]*>/g, ''), submitted) }}
                    />
                  ) : (
                    <p
                      className="text-sm leading-6 text-slate-800 dark:text-slate-200 [&_mark]:rounded-sm [&_mark]:bg-amber-200 [&_mark]:px-0.5 dark:[&_mark]:bg-amber-700 dark:[&_mark]:text-amber-100"
                      dangerouslySetInnerHTML={{
                        __html: highlightText(
                          extractContextSnippet(result.content, submitted),
                          submitted,
                        ),
                      }}
                    />
                  )}

                  {/* Tags */}
                  {result.metadata?.tags && result.metadata.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {result.metadata.tags.slice(0, 5).map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Meta badges */}
                  <div className="flex items-center gap-2 pt-1">
                    <Badge
                      variant="secondary"
                      className="border-indigo-100 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300"
                    >
                      {typeLabel(result.type)}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400"
                    >
                      {statusLabel(result.status)}
                    </Badge>
                    {result.createdAt && (
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(result.createdAt).toLocaleDateString('zh-CN')}
                      </span>
                    )}
                  </div>
                </Link>

                {/* Score + Actions */}
                <div className="flex items-start gap-2 shrink-0">
                  <div className="rounded-2xl bg-slate-50 px-3 py-2 text-right dark:bg-slate-800">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                      相关度
                    </p>
                    <p className="text-base font-semibold text-slate-900 dark:text-slate-100">
                      {(result.score * 100).toFixed(0)}%
                    </p>
                  </div>

                  {/* Action menu */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="rounded-lg p-1.5 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-600 focus:opacity-100 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                        aria-label={`${result.id} 的操作菜单`}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem
                        onClick={() => router.push(`/knowledge/${result.id}`)}
                        className="gap-2 cursor-pointer"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        查看详情
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleViewInGraph(result.id)}
                        className="gap-2 cursor-pointer"
                      >
                        <Network className="h-3.5 w-3.5" />
                        在图谱中查看
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => handleCopyLink(result.id)}
                        className="gap-2 cursor-pointer"
                      >
                        {copiedId === result.id ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-green-600" />
                            <span className="text-green-600">已复制</span>
                          </>
                        ) : (
                          <>
                            <Link2 className="h-3.5 w-3.5" />
                            复制引用链接
                          </>
                        )}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
