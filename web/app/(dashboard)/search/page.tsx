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
  SlidersHorizontal,
  Tag,
  X,
  Loader2,
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
  title?: string;
  summary?: string;
  content: string;
  score: number;
  createdAt?: string;
  highlights?: string[];
  metadata?: { tags?: string[]; knowledgeDomain?: string };
  source?: { reference?: string; type?: string };
}

interface SearchSuggestion {
  id: string;
  title: string;
  type: string;
}

type SearchTab = 'all' | 'domain' | 'intent' | 'material';

const SEARCH_TABS: { value: SearchTab; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'domain', label: '领域知识' },
  { value: 'intent', label: '意图知识' },
  { value: 'material', label: '材料' },
];

const DOMAIN_TYPES = new Set(['fact', 'methodology', 'decision', 'experience', 'meta', 'wiki_page', 'wiki_space']);

/** Classify a result into one of the search tabs by its knowledge type / source. */
function classifyResult(r: SearchResult): SearchTab {
  if (r.type === 'intent') return 'intent';
  if (r.type?.startsWith('material') || r.source?.type === 'document') return 'material';
  if (DOMAIN_TYPES.has(r.type)) return 'domain';
  return 'domain';
}


function resultHref(result: SearchResult): string {
  if (classifyResult(result) === 'material') return `/wiki/materials?material=${encodeURIComponent(result.id)}`;
  return `/knowledge/${encodeURIComponent(result.id)}`;
}
/** Relevance tier (高/中/低) derived from the cosine score — spec FR-W02 step 3. */
function relevanceTier(score: number): { label: string; className: string } {
  if (score >= 0.75) return { label: '相关度高', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' };
  if (score >= 0.5) return { label: '相关度中', className: 'border-amber-200 bg-amber-50 text-amber-700' };
  return { label: '相关度低', className: 'border-slate-200 bg-slate-50 text-slate-600' };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const EXAMPLE_QUERIES = ['知识库的创建步骤', '最新的领域知识', '如何建立知识关联', '知识条目的状态说明'];

const KNOWLEDGE_TYPE_CHIPS = [
  { value: 'all-types', label: '全部', color: '' },
  { value: 'fact', label: '事实', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  { value: 'decision', label: '决策', color: 'bg-violet-100 text-violet-800 border-violet-200' },
  { value: 'methodology', label: '方法论', color: 'bg-green-100 text-green-800 border-green-200' },
  { value: 'experience', label: '经验', color: 'bg-orange-100 text-orange-800 border-orange-200' },
  { value: 'meta', label: '元知识', color: 'bg-gray-100 text-gray-800 border-gray-200' },
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
  return escapeHtml(text).replace(regex, '<mark class="rounded-sm bg-amber-200 px-0.5">$1</mark>');
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
  const [knowledgeDomain, setKnowledgeDomain] = useState('all-domains');
  const [activeTab, setActiveTab] = useState<SearchTab>('all');
  const [minConfidence, setMinConfidence] = useState(0);
  const [tagsInput, setTagsInput] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [activeResultIndex, setActiveResultIndex] = useState(-1);
  const [activeHistoryIndex, setActiveHistoryIndex] = useState(-1);
  const [searchNonce, setSearchNonce] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
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
    search.set('rid', String(searchNonce));
    if (type !== 'all-types') search.set('type', type);
    if (status !== 'all-statuses') search.set('status', status);
    if (knowledgeDomain !== 'all-domains') search.set('knowledgeDomain', knowledgeDomain);
    return `/api/v1/search?${search.toString()}`;
  }, [submitted, type, status, knowledgeDomain, searchNonce]);

  const suggestionParams = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return null;
    const search = new URLSearchParams();
    search.set('q', trimmed);
    search.set('suggest', '1');
    return `/api/v1/search?${search.toString()}`;
  }, [query]);

  const { data, isLoading, error, mutate, isValidating } = useApi<ApiResponse<SearchResult[]>>(params);
  const { data: suggestionData } = useApi<ApiResponse<SearchSuggestion[]>>(suggestionParams, {
    keepPreviousData: true,
  });

  useEffect(() => {
    if (!submitted) {
      setIsSubmitting(false);
      return;
    }
    if (data || error) {
      setIsSubmitting(false);
    }
  }, [submitted, data, error]);

  const isSearchPending = Boolean(submitted) && !error && (isSubmitting || isLoading || isValidating);

  // Fetch recent items for empty state
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

  const tabCounts = useMemo(() => {
    const counts: Record<SearchTab, number> = { all: results.length, domain: 0, intent: 0, material: 0 };
    for (const r of results) counts[classifyResult(r)] += 1;
    return counts;
  }, [results]);

  const tabbedResults = useMemo(() => {
    if (activeTab === 'all') return results;
    return results.filter((r) => classifyResult(r) === activeTab);
  }, [results, activeTab]);

  const executeSearch = useCallback((term: string) => {
    const normalized = term.trim();
    if (!normalized) return;
    setQuery(normalized);
    setSubmitted(normalized);
    setSearchNonce((value) => value + 1);
    setIsSubmitting(true);
    addSearchHistory(normalized);
    setSearchHistory(getSearchHistory());
    setShowHistory(false);
    setActiveResultIndex(-1);
    setActiveHistoryIndex(-1);
  }, []);

  const suggestions = useMemo(() => suggestionData?.data ?? [], [suggestionData]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      executeSearch(query);
    },
    [query, executeSearch],
  );

  const handleCopyLink = useCallback(
    (result: SearchResult) => {
      const url = `${window.location.origin}${resultHref(result)}`;
      navigator.clipboard.writeText(url).then(() => {
        setCopiedId(result.id);
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
    executeSearch(term);
  }, [executeSearch]);

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
      if (!tabbedResults.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveResultIndex((prev) => (prev < tabbedResults.length - 1 ? prev + 1 : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveResultIndex((prev) => (prev > 0 ? prev - 1 : tabbedResults.length - 1));
      } else if (e.key === 'Enter' && activeResultIndex >= 0 && !(e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) {
        e.preventDefault();
        const target = tabbedResults[activeResultIndex];
        if (target) router.push(resultHref(target));
      }
    },
    [tabbedResults, activeResultIndex, showHistory, searchHistory, activeHistoryIndex, router, handleHistorySelect],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">语义搜索</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          直接输入问题、主题关键词或一段自然语言。系统会基于语义匹配返回相关知识条目。
        </p>
      </div>

      {/* Search form */}
      <div className="rounded-[28px] border border-slate-200/80 bg-white/95 p-5 shadow-sm sm:p-6" onKeyDown={handleKeyDown}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex flex-col gap-3 xl:flex-row">
            <div className="relative flex-1" ref={historyRef}>
              <SearchIcon className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                className="h-12 rounded-2xl border-slate-200 bg-slate-50 pl-11 pr-4 text-base shadow-sm"
                placeholder={'例如：搜索"知识库的创建步骤"或"最新的领域知识"'}
                value={query}
                onChange={(e) => {
                  const val = e.target.value;
                  setQuery(val);
                  setActiveResultIndex(-1);
                  if (val) {
                    setShowHistory(false);
                    setActiveHistoryIndex(-1);
                  } else if (searchHistory.length > 0) {
                    setShowHistory(true);
                    setActiveHistoryIndex(-1);
                  }
                }}
                onFocus={() => { if (!query && searchHistory.length > 0) { setShowHistory(true); setActiveHistoryIndex(-1); } }}
                aria-label="输入搜索问题"
              />
              {showHistory && searchHistory.length > 0 && !query && !isFocus && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-xl border border-slate-200 bg-white shadow-lg">
                  <div className="flex items-center justify-between px-4 py-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><History className="h-3 w-3" />搜索历史</span>
                    <span className="text-[10px]">↑↓ 选择 · Enter 确认</span>
                  </div>
                  {searchHistory.map((term, idx) => (
                    <button
                      key={term}
                      type="button"
                      className={`flex w-full items-center justify-between px-4 py-2 text-sm transition-colors ${idx === activeHistoryIndex ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700 hover:bg-slate-50'}`}
                      onClick={() => handleHistorySelect(term)}
                    >
                      <span className="truncate">{term}</span>
                      <X
                        className="h-3.5 w-3.5 shrink-0 text-slate-400 hover:text-slate-600"
                        onClick={(e) => handleRemoveHistory(term, e)}
                      />
                    </button>
                  ))}
                </div>
              )}
              {query.trim().length >= 2 && suggestions.length > 0 && !isFocus && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-xl border border-slate-200 bg-white shadow-lg">
                  <div className="flex items-center justify-between px-4 py-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><Sparkles className="h-3 w-3" />搜索建议</span>
                    <span className="text-[10px]">来自已有标题</span>
                  </div>
                  {suggestions.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-50"
                      onClick={() => executeSearch(item.title)}
                    >
                      <span className="truncate">{item.title}</span>
                      <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">{typeLabel(item.type)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button
              type="submit"
              disabled={!query.trim() || isSearchPending}
              className="h-12 rounded-2xl px-6 text-base font-semibold xl:min-w-[132px]"
            >
              {isSearchPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  搜索中
                </>
              ) : (
                '搜索知识'
              )}
            </Button>
          </div>

          <div className={isFocus ? 'hidden' : 'space-y-3'}>
            <div className="flex flex-wrap items-center gap-2">
              {EXAMPLE_QUERIES.slice(0, 3).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => executeSearch(item)}
                  className="rounded-full border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 transition-colors hover:bg-indigo-100"
                >
                  {item}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
              >
                <SlidersHorizontal className="h-4 w-4" />
                高级筛选
              </button>
            </div>

            {showAdvanced && (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger className="h-10" aria-label="按知识状态过滤搜索结果"><SelectValue placeholder="全部状态" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all-statuses">全部状态</SelectItem>
                      <SelectItem value="active">活跃</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={type} onValueChange={setType}>
                    <SelectTrigger className="h-10" aria-label="按知识类型过滤搜索结果"><SelectValue placeholder="全部类型" /></SelectTrigger>
                    <SelectContent>
                      {KNOWLEDGE_TYPE_CHIPS.map((chip) => <SelectItem key={chip.value} value={chip.value}>{chip.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input className="h-10" placeholder="知识域筛选" value={knowledgeDomain === 'all-domains' ? '' : knowledgeDomain} onChange={(e) => setKnowledgeDomain(e.target.value.trim() || 'all-domains')} aria-label="按知识域筛选" />
                  <div className="flex items-center gap-2 rounded-xl border border-slate-200 px-3">
                    <Clock className="h-3.5 w-3.5 text-slate-400" />
                    <select value={timeRange} onChange={(e) => setTimeRange(e.target.value)} className="h-10 flex-1 bg-transparent text-sm text-slate-700 outline-none" aria-label="时间范围">
                      {TIME_RANGE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  </div>
                  <Input className="h-10" placeholder="标签筛选（逗号分隔）" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} aria-label="按标签筛选" />
                </div>
                <div className="mt-3 flex items-center gap-2 text-sm text-slate-500">
                  <span>置信度 ≥</span>
                  <input type="range" min={0} max={100} step={5} value={minConfidence} onChange={(e) => setMinConfidence(parseInt(e.target.value))} className="h-1.5 w-32 cursor-pointer appearance-none rounded-full bg-slate-200 accent-indigo-500" aria-label="最低置信度" />
                  <span className="w-8 text-slate-700">{minConfidence}%</span>
                </div>
              </div>
            )}
          </div>
        </form>
      </div>

      {/* First-use guidance */}
      {!submitted && (
        <div className="rounded-[28px] border border-slate-200 bg-slate-50 p-6 shadow-sm">
          <div className="flex items-center gap-2 text-indigo-600">
            <Lightbulb className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-[0.2em]">推荐问题</span>
          </div>
          <h2 className="mt-3 text-xl font-semibold text-slate-900">直接问一句话，KIVO 会返回答案、引用和命中原因</h2>
          <div className="mt-5 flex flex-wrap gap-3">
            {EXAMPLE_QUERIES.slice(0, 3).map((item) => (
              <button key={item} type="button" onClick={() => executeSearch(item)} className="rounded-full border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 transition-colors hover:bg-indigo-100">
                {item}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Error state */}
      {error && submitted && (
        <ErrorState
          title="搜索请求失败"
          description={error.message || '暂时拿不到搜索结果，请稍后再试。'}
          onRetry={() => {
            setIsSubmitting(true);
            void mutate();
          }}
        />
      )}

      {/* Loading */}
      {isSearchPending && <ResultsSkeleton rows={3} />}

      {/* Empty results */}
      {submitted && !isSearchPending && !error && results.length === 0 && (
        <EmptyState
          icon={SearchIcon}
          title={`未找到与"${submitted}"相关的结果`}
          description={'试试换成更明确的主题名称、操作场景或领域术语；也可以上传材料或发起调研补齐空白。'}
          primaryAction={{ label: '上传材料', href: '/wiki/materials' }}
          secondaryAction={{ label: '发起调研', href: '/research', variant: 'outline' }}
        />
      )}
      {/* Results list */}
      {!error && results.length > 0 && (
        <div className="space-y-3">
          {/* Tab bar — 全部 / 领域知识 / 意图知识 / 材料 (FR-W02) */}
          <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
            {SEARCH_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => { setActiveTab(tab.value); setActiveResultIndex(-1); }}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${activeTab === tab.value ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                aria-pressed={activeTab === tab.value}
              >
                {tab.label}
                <span className={`ml-1.5 text-xs ${activeTab === tab.value ? 'text-indigo-100' : 'text-slate-400'}`}>{tabCounts[tab.value]}</span>
              </button>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            找到 {tabbedResults.length} 条结果
            {minConfidence > 0 && (
              <span className="ml-1">
                （置信度 ≥ {minConfidence}% 过滤后）
              </span>
            )}
            <span className="ml-2 text-xs text-slate-500">↑↓ 导航 · Enter 打开</span>
          </p>
          {tabbedResults.length === 0 ? (
            <EmptyState
              icon={SearchIcon}
              title="该分类下暂无结果"
              description="切换到「全部」或其他分类查看更多结果。"
            />
          ) : tabbedResults.map((result, idx) => (
            <div
              key={result.id}
              className={`group relative rounded-[24px] border p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md ${idx === activeResultIndex ? 'border-indigo-300 bg-indigo-50/50 ring-2 ring-indigo-200' : 'border-slate-200 bg-white/95'}`}
            >
              <div className="flex items-start justify-between gap-3">
                <Link
                  href={resultHref(result)}
                  className="min-w-0 flex-1 space-y-2"
                >
                  {/* Title (keyword highlighted) */}
                  {result.title?.trim() && (
                    <h3
                      className="text-base font-semibold leading-6 text-slate-900 [&_mark]:rounded-sm [&_mark]:bg-amber-200 [&_mark]:px-0.5"
                      dangerouslySetInnerHTML={{ __html: highlightText(result.title.trim(), submitted) }}
                    />
                  )}
                  {/* Content with keyword highlighting and context snippet */}
                  {result.highlights?.length ? (
                    <p
                      className="text-sm leading-6 text-slate-800 [&_mark]:rounded-sm [&_mark]:bg-amber-200 [&_mark]:px-1"
                      dangerouslySetInnerHTML={{ __html: highlightText(result.highlights[0].replace(/<[^>]*>/g, ''), submitted) }}
                    />
                  ) : (
                    <p
                      className="text-sm leading-6 text-slate-800 [&_mark]:rounded-sm [&_mark]:bg-amber-200 [&_mark]:px-0.5"
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
                          className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Meta badges */}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Badge
                      variant="secondary"
                      className="border-indigo-100 bg-indigo-50 text-indigo-700"
                    >
                      {typeLabel(result.type)}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="border-slate-200 bg-slate-50 text-slate-600"
                    >
                      {statusLabel(result.status)}
                    </Badge>
                    <Badge variant="outline" className={relevanceTier(result.score).className}>
                      {relevanceTier(result.score).label}
                    </Badge>
                    {result.source?.reference && (
                      <span className="truncate text-[11px] text-muted-foreground" title={result.source.reference}>
                        来源: {result.source.reference}
                      </span>
                    )}
                    {result.createdAt && (
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(result.createdAt).toLocaleDateString('zh-CN')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">命中原因：基于向量语义匹配与知识类型综合排序。</p>
                </Link>

                <div className="flex items-start gap-2 shrink-0">


                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="rounded-lg p-1.5 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-600 focus:opacity-100"
                        aria-label={`${result.id} 的操作菜单`}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem
                        onClick={() => router.push(resultHref(result))}
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
                        onClick={() => handleCopyLink(result)}
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
