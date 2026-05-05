'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { Clock, FileEdit, FilePlus2, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ListPageSkeleton } from '@/components/ui/page-states';
import { TimelinePlayback } from '@/components/timeline-playback';
import {
  KnowledgeGraphView,
  type GraphSnapshot,
} from '@/components/knowledge-graph/KnowledgeGraphView';
import { useApi } from '@/hooks/use-api';
import type { ApiResponse } from '@/types';
import { useCognitiveMode } from '@/contexts/cognitive-mode-context';
import { CognitivePanel } from '@/components/cognitive-panel';
import { DailyActivityChart } from '@/components/overview-charts';
import type { KnowledgeEntry } from '@self-evolving-harness/kivo';
import { TYPE_LABELS, typeLabel } from '@/lib/i18n-labels';

type KnowledgeTypeFilter = 'all' | 'fact' | 'methodology' | 'decision' | 'experience' | 'intent' | 'meta';

const TYPE_FILTERS: { key: KnowledgeTypeFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'fact', label: '事实' },
  { key: 'methodology', label: '方法论' },
  { key: 'decision', label: '决策' },
  { key: 'experience', label: '经验' },
  { key: 'intent', label: '意图' },
  { key: 'meta', label: '元知识' },
];

function inferEventType(entry: KnowledgeEntry): { label: string; icon: typeof FilePlus2; accent: string } {
  const created = new Date(entry.createdAt).getTime();
  const updated = new Date(entry.updatedAt).getTime();
  const diff = updated - created;

  if (diff < 1000) {
    return { label: '创建', icon: FilePlus2, accent: 'bg-emerald-500 dark:bg-emerald-600' };
  }
  if (entry.status === 'deprecated' || entry.status === 'archived') {
    return { label: '归档', icon: AlertTriangle, accent: 'bg-amber-500 dark:bg-amber-600' };
  }
  return { label: '修改', icon: FileEdit, accent: 'bg-sky-500 dark:bg-sky-600' };
}

function groupByDate(entries: KnowledgeEntry[]): [string, KnowledgeEntry[]][] {
  const groups: Record<string, KnowledgeEntry[]> = {};
  for (const entry of entries) {
    const key = new Date(entry.updatedAt).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    groups[key] ||= [];
    groups[key].push(entry);
  }
  return Object.entries(groups);
}

const PAGE_SIZE = 30;

export default function TimelinePage() {
  const [typeFilter, setTypeFilter] = useState<KnowledgeTypeFilter>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [playbackEnabled, setPlaybackEnabled] = useState(false);
  const { isOverview } = useCognitiveMode();
  const [sliderValue, setSliderValue] = useState<number | null>(null);

  const typeParam = typeFilter === 'all' ? '' : `&type=${typeFilter}`;
  const { data, isLoading, error, mutate } = useApi<ApiResponse<KnowledgeEntry[]>>(
    `/api/v1/knowledge?sort=-updatedAt&pageSize=100${typeParam}`
  );
  const { data: graphData } = useApi<ApiResponse<GraphSnapshot>>('/api/v1/graph');

  const entries = data?.data ?? [];

  const timeRange = useMemo(() => {
    if (entries.length === 0) return { min: Date.now(), max: Date.now() };
    const times = entries.map((e) => new Date(e.createdAt).getTime());
    return { min: Math.min(...times), max: Math.max(...times) };
  }, [entries]);

  const currentSlider = sliderValue ?? timeRange.max;

  const handleSliderChange = useCallback((ts: number) => {
    setSliderValue(ts);
  }, []);

  const filteredEntries = useMemo(() => {
    if (!playbackEnabled) return entries;
    return entries.filter((e) => new Date(e.createdAt).getTime() <= currentSlider);
  }, [entries, playbackEnabled, currentSlider]);

  const filteredGraph = useMemo((): GraphSnapshot | null => {
    if (!graphData?.data || !playbackEnabled) return graphData?.data ?? null;
    const snapshot = graphData.data;
    const visibleIds = new Set(
      snapshot.nodes
        .filter((n) => new Date(n.createdAt).getTime() <= currentSlider)
        .map((n) => n.id),
    );
    return {
      ...snapshot,
      nodes: snapshot.nodes.filter((n) => visibleIds.has(n.id)),
      edges: snapshot.edges.filter((e) => visibleIds.has(e.sourceId) && visibleIds.has(e.targetId)),
    };
  }, [graphData, playbackEnabled, currentSlider]);

  const relationCount = filteredGraph?.edges.length ?? 0;

  const grouped = useMemo(() => {
    const visible = filteredEntries.slice(0, visibleCount);
    return groupByDate(visible);
  }, [filteredEntries, visibleCount]);

  const hasMore = visibleCount < filteredEntries.length;

  // Overview mode: daily activity counts
  const dailyActivity = useMemo(() => {
    const days = 30;
    const now = new Date();
    const result: { date: string; count: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const label = `${d.getMonth() + 1}/${d.getDate()}`;
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      const count = entries.filter((e) => {
        const t = new Date(e.updatedAt).getTime();
        return t >= d.getTime() && t < next.getTime();
      }).length;
      result.push({ date: label, count });
    }
    return result;
  }, [entries]);

  if (isLoading) return <ListPageSkeleton filters={6} rows={8} />;

  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 py-20">
        <p className="text-sm text-muted-foreground">加载失败：{error.message}</p>
        <Button variant="outline" size="sm" onClick={() => void mutate()}>重试</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950 dark:text-slate-50">知识时间线</h1>
          <Badge variant="secondary" className="text-xs">{filteredEntries.length} 条</Badge>
        </div>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          知识库的演化轨迹——每一次创建、修改、归档都在这里留下印记。
        </p>
      </div>

      {/* Overview mode: Daily activity chart */}
      <CognitivePanel visible={isOverview}>
        <div className="rounded-2xl border border-slate-200/80 bg-white/95 p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900/95">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">每日活动量</p>
              <p className="text-xs text-muted-foreground">最近 30 天知识变更频率</p>
            </div>
          </div>
          <DailyActivityChart data={dailyActivity} width={600} height={48} />
        </div>
      </CognitivePanel>

      <div className="flex flex-wrap items-center gap-2">
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => { setTypeFilter(f.key); setVisibleCount(PAGE_SIZE); }}
            className={`rounded-full px-3 py-1 text-sm transition-colors ${
              typeFilter === f.key
                ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-950'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
            }`}
            aria-pressed={typeFilter === f.key}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setPlaybackEnabled((p) => !p);
            setSliderValue(null);
          }}
          className={`rounded-full px-3 py-1 text-sm transition-colors ${
            playbackEnabled
              ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-950'
              : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
          }`}
          aria-pressed={playbackEnabled}
        >
          时间轴回放
        </button>
      </div>

      {playbackEnabled && entries.length > 0 && (
        <div className="space-y-4">
          <TimelinePlayback
            minTime={timeRange.min}
            maxTime={timeRange.max}
            value={currentSlider}
            onChange={handleSliderChange}
            totalCount={entries.length}
            visibleCount={filteredEntries.length}
            relationCount={relationCount}
          />
          {filteredGraph && filteredGraph.nodes.length > 0 && (
            <div className="h-64 overflow-hidden rounded-xl border border-slate-200/80 dark:border-slate-700/60">
              <KnowledgeGraphView snapshot={filteredGraph} />
            </div>
          )}
        </div>
      )}

      {filteredEntries.length === 0 && entries.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="时间线暂无记录"
          description="创建第一条知识后，时间线会开始记录演化轨迹。"
          primaryAction={{ label: '去创建知识', href: '/knowledge' }}
        />
      ) : filteredEntries.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          该时间点之前还没有知识条目，拖动滑块向右查看更多。
        </div>
      ) : (
        <div className="relative ml-4 border-l-2 border-slate-200 pl-8 dark:border-slate-700">
          {grouped.map(([date, items]) => (
            <div key={date} className="mb-8">
              <div className="sticky top-0 z-10 -ml-[calc(2rem+1px)] mb-4 flex items-center gap-3">
                <div className="h-3 w-3 rounded-full border-2 border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-900" />
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                  {date}
                </span>
              </div>

              <div className="space-y-3">
                {items.map((entry) => {
                  const event = inferEventType(entry);
                  const Icon = event.icon;
                  return (
                    <div key={entry.id} className="group relative">
                      <div className="absolute -left-[calc(2rem+5px)] top-3 h-2.5 w-2.5 rounded-full border-2 border-white bg-slate-400 dark:border-slate-900 dark:bg-slate-500" />
                      <Link
                        href={`/knowledge/${entry.id}`}
                        className="block rounded-xl border border-slate-200/80 bg-white/95 p-4 shadow-sm transition-all hover:border-slate-300 hover:shadow-md dark:border-slate-700/60 dark:bg-slate-900/95 dark:hover:border-slate-600"
                      >
                        <div className="flex items-start gap-3">
                          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white ${event.accent}`}>
                            <Icon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="line-clamp-1 text-sm font-medium text-slate-950 dark:text-slate-50">
                                {entry.title || '未命名'}
                              </span>
                              <Badge variant="outline" className="shrink-0 text-[10px]">
                                {event.label}
                              </Badge>
                              <Badge variant="secondary" className="shrink-0 text-[10px]">
                                {TYPE_LABELS[entry.type] ?? entry.type}
                              </Badge>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                              {entry.summary}
                            </p>
                            <span className="mt-1.5 block text-[11px] text-slate-400 dark:text-slate-500">
                              {new Date(entry.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        </div>
                      </Link>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {hasMore && (
            <div className="flex justify-center py-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              >
                加载更多
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
