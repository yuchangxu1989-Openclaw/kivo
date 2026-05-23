'use client';

import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  FileDiff,
  Radio,
  RefreshCw,
  SearchCheck,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '@/hooks/use-api';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import type { ApiResponse } from '@/types';
import type { ActivityEvent, ActivityFeedData } from '@/lib/demo-dashboard-data';

const eventTypeMeta: Record<string, { icon: typeof Activity; accent: string; bg: string }> = {
  knowledge_created: { icon: Sparkles, accent: 'text-emerald-600', bg: 'bg-emerald-50' },
  knowledge_imported: { icon: Sparkles, accent: 'text-teal-600', bg: 'bg-teal-50' },
  conflict_detected: { icon: FileDiff, accent: 'text-rose-600', bg: 'bg-rose-50' },
  conflict_resolved: { icon: FileDiff, accent: 'text-emerald-600', bg: 'bg-emerald-50' },
  research_completed: { icon: SearchCheck, accent: 'text-indigo-600', bg: 'bg-indigo-50' },
  knowledge_expired: { icon: ShieldAlert, accent: 'text-amber-600', bg: 'bg-amber-50' },
  rule_changed: { icon: Activity, accent: 'text-sky-600', bg: 'bg-sky-50' },
};

type EventTypeFilter = 'all' | 'knowledge' | 'conflict' | 'research' | 'system';

const EVENT_TYPE_FILTERS: { key: EventTypeFilter; label: string }[] = [
  { key: 'all', label: '全部事件' },
  { key: 'knowledge', label: '知识变更' },
  { key: 'conflict', label: '冲突' },
  { key: 'research', label: '调研' },
  { key: 'system', label: '系统' },
];

const EVENT_TYPE_MAPPING: Record<EventTypeFilter, string[]> = {
  all: [],
  knowledge: ['knowledge_created', 'knowledge_imported', 'knowledge_expired'],
  conflict: ['conflict_detected', 'conflict_resolved'],
  research: ['research_completed'],
  system: ['rule_changed'],
};

function getDetailHref(event: ActivityEvent): string | null {
  if (!event.href) return null;
  return event.href;
}

function groupByDate(items: ActivityEvent[]) {
  return items.reduce<Record<string, ActivityEvent[]>>((acc, item) => {
    const dateKey = new Date(item.occurredAt).toLocaleDateString('zh-CN');
    acc[dateKey] ||= [];
    acc[dateKey].push(item);
    return acc;
  }, {});
}

function formatRefreshTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

type ConnectionState = 'connected' | 'reconnecting' | 'polling';

export default function ActivityPage() {
  const [activeFilter, setActiveFilter] = useState<EventTypeFilter>('all');
  const [pollingError, setPollingError] = useState<string | null>(null);
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connected');
  const lastEventIdRef = useRef('');
  const pollingErrorRef = useRef(false);
  const reconnectAttemptRef = useRef(0);

  const apiFilterParam = activeFilter === 'all' ? 'all' : activeFilter;
  const { data, isLoading, error, mutate } = useApi<ApiResponse<ActivityFeedData>>(`/api/v1/activity?type=${apiFilterParam}`);
  const feed = data?.data;
  const [liveEvents, setLiveEvents] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    if (data) {
      setLastRefreshTime(new Date());
    }
  }, [data]);

  useEffect(() => {
    if (!feed?.items?.length) return;
    let cancelled = false;
    let eventSource: EventSource | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function getBackoffDelay(): number {
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      return delay;
    }

    function startSSE() {
      if (cancelled) return;
      setConnectionState(reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connected');
      eventSource = new EventSource(`/api/v1/activity/stream?type=${apiFilterParam}`);
      eventSource.onmessage = (event) => {
        if (cancelled) return;
        try {
          const items = JSON.parse(event.data) as ActivityEvent[];
          if (items.length > 0) {
            setLiveEvents((prev) => [...items, ...prev]);
            lastEventIdRef.current = items[items.length - 1].eventId || items[items.length - 1].id;
          }
          // SSE connected successfully - reset state
          if (reconnectAttemptRef.current > 0) {
            // Reconnected after disconnect - refresh full data
            void mutate();
          }
          reconnectAttemptRef.current = 0;
          setPollingError(null);
          pollingErrorRef.current = false;
          setConnectionState('connected');
          setLastRefreshTime(new Date());
          // Stop fallback polling if SSE reconnected
          if (fallbackTimer) {
            clearInterval(fallbackTimer);
            fallbackTimer = null;
          }
        } catch { /* ignore parse errors */ }
      };
      eventSource.addEventListener('history-lost', () => {
        if (cancelled) return;
        lastEventIdRef.current = '';
        setLiveEvents([]);
        void mutate();
      });
      eventSource.onerror = () => {
        if (cancelled) return;
        eventSource?.close();
        eventSource = null;
        pollingErrorRef.current = true;
        reconnectAttemptRef.current += 1;

        const delay = getBackoffDelay();
        if (delay >= 30000) {
          // Max backoff reached - fall back to polling
          setConnectionState('polling');
          setPollingError('实时连接断开，已降级为轮询');
          startFallbackPolling();
        } else {
          // Try to reconnect with exponential backoff
          setConnectionState('reconnecting');
          setPollingError(`连接中断，${Math.round(delay / 1000)}秒后重连...`);
          reconnectTimer = setTimeout(() => {
            if (!cancelled) startSSE();
          }, delay);
        }
      };
    }

    function startFallbackPolling() {
      if (fallbackTimer || cancelled) return;
      const initialLastEventId = lastEventIdRef.current || feed!.items[0]?.eventId || feed!.items[0]?.id;
      fallbackTimer = setInterval(async () => {
        if (cancelled) return;
        try {
          const response = await fetch(`/api/v1/activity?type=${apiFilterParam}&since=${initialLastEventId ?? ''}`);
          if (!response.ok) throw new Error(`请求失败 (${response.status})`);
          const payload = await response.json() as ApiResponse<ActivityFeedData>;
          if (!cancelled && payload.data.items.length > 0) {
            setLiveEvents(payload.data.items);
            lastEventIdRef.current = payload.data.items[payload.data.items.length - 1].eventId || payload.data.items[payload.data.items.length - 1].id;
          }
          setLastRefreshTime(new Date());
          // Periodically try to reconnect SSE even while polling
          if (!cancelled && !eventSource) {
            reconnectAttemptRef.current = 0;
            if (fallbackTimer) {
              clearInterval(fallbackTimer);
              fallbackTimer = null;
            }
            startSSE();
          }
        } catch (err) {
          if (!cancelled) {
            setPollingError(err instanceof Error ? err.message : '轮询失败，请检查网络连接');
          }
        }
      }, 30000);
    }

    startSSE();

    return () => {
      cancelled = true;
      eventSource?.close();
      if (fallbackTimer) clearInterval(fallbackTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [feed?.items, apiFilterParam, mutate]);

  const activityEvents = useMemo(() => {
    const all = [...liveEvents, ...(feed?.items ?? [])];
    const unique = new Map<string, ActivityEvent>();
    all.forEach((item) => unique.set(item.id, item));
    return Array.from(unique.values()).sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
  }, [feed?.items, liveEvents]);

  const filteredEvents = useMemo(() => {
    if (activeFilter === 'all') return activityEvents;
    const allowedTypes = EVENT_TYPE_MAPPING[activeFilter];
    if (!allowedTypes.length) return activityEvents;
    return activityEvents.filter((e) => allowedTypes.includes(e.type));
  }, [activityEvents, activeFilter]);

  const groupedEvents = useMemo(() => groupByDate(filteredEvents), [filteredEvents]);

  const handleManualRefresh = useCallback(async () => {
    setIsManualRefreshing(true);
    try {
      await mutate();
      setPollingError(null);
      pollingErrorRef.current = false;
      setLastRefreshTime(new Date());
    } catch {
      setPollingError('手动刷新失败，请稍后重试');
    } finally {
      setIsManualRefreshing(false);
    }
  }, [mutate]);

  if (isLoading) {
    return <ListPageSkeleton filters={4} rows={5} />;
  }

  if (error) {
    return (
      <ErrorState
        title="活动流加载失败"
        description={error.message || '暂时拿不到最近事件，请稍后再试。'}
        onRetry={() => void mutate()}
      />
    );
  }

  if (!feed) {
    return (
      <EmptyState
        icon={Activity}
        title="还没有动态记录"
        description="知识库有新变更时，这里会自动展示。"
        primaryAction={{ label: '前往知识库', href: '/knowledge' }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950">动态</h1>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-muted-foreground">
              实时推送
            </span>
          </div>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            最近的知识库变更记录，按时间倒序展示。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleManualRefresh}
            disabled={isManualRefreshing}
            aria-label="手动刷新活动流"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${isManualRefreshing ? 'animate-spin' : ''}`} />
            刷新
          </Button>
          <Button asChild>
            <Link href="/research">去看调研队列</Link>
          </Button>
        </div>
      </div>

      {/* ── Polling Status Bar ── */}
      <div className="flex flex-wrap items-center gap-2">
        {EVENT_TYPE_FILTERS.map((filter) => (
          <button
            key={filter.key}
            type="button"
            onClick={() => setActiveFilter(filter.key)}
            className={`rounded-full px-3 py-1 text-sm transition-colors ${activeFilter === filter.key ? 'bg-slate-950 text-white' : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
            aria-pressed={activeFilter === filter.key}
          >
            {filter.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3">
          {lastRefreshTime && (
            <span className="text-xs text-muted-foreground">
              上次刷新：{formatRefreshTime(lastRefreshTime)}
            </span>
          )}
          {connectionState === 'reconnecting' ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs text-sky-700">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              连接中...
            </div>
          ) : pollingError ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5" />
              {pollingError}
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700">
              <Radio className="h-3.5 w-3.5" />
              自动刷新中
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-5">
          {Object.keys(groupedEvents).length === 0 ? (
            <EmptyState
              icon={Activity}
              title="当前筛选下没有事件"
              description="试试切换事件类型筛选，或等待新事件产生。"
            />
          ) : (
            Object.entries(groupedEvents).map(([date, items]) => (
              <div key={date} className="space-y-3">
                <div className="sticky top-0 z-10 inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{date}</div>
                {items.map((event) => {
                  const meta = eventTypeMeta[event.type] ?? eventTypeMeta.rule_changed;
                  const Icon = meta.icon;
                  const detailHref = getDetailHref(event);
                  return (
                    <Card key={event.id} className="border-slate-200/80 bg-white/95 shadow-sm">
                      <CardContent className="flex gap-4 p-5 sm:p-6">
                        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${meta.bg} ${meta.accent}`}>
                          <Icon className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="space-y-1">
                              <p className="text-sm font-semibold text-slate-950">{event.label}</p>
                              <p className="text-xs text-muted-foreground">{event.time}</p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {event.tags.map((tag) => (
                                <Badge key={tag} variant="outline">{tag}</Badge>
                              ))}
                            </div>
                          </div>
                          <p className="text-sm leading-6 text-slate-700">{event.summary}</p>
                          {detailHref && (
                            <Link href={detailHref} className="inline-flex items-center text-sm font-medium text-indigo-600 hover:text-indigo-500">
                              查看详情 →
                            </Link>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="space-y-4">
          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl">事件类型覆盖</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>活动流覆盖七类核心事件：创建、更新、废弃、冲突检测、冲突解决、调研完成、规则变更。</p>
              <p>活动流通过 SSE 实时推送新事件，断线后浏览器原生重连会携带 Last-Event-ID，服务端从内存环形缓存补发缺失事件；缓存过期时自动全量刷新。</p>
            </CardContent>
          </Card>

          <Card className="border-slate-200/80 bg-slate-50 shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl">下一步建议</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-6 text-slate-600">
              <p>查看缺口报告，然后决定是否手动触发调研。</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" asChild>
                  <Link href="/gaps">查看缺口报告</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
