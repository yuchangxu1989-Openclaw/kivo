'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  BookPlus,
  FileInput,
  Radio,
  RefreshCw,
  SearchCheck,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import { apiFetch, withBasePath } from '@/lib/client-api';

// ─── Types ──────────────────────────────────────────────────────────────────

interface OperationLogEntry {
  id: number;
  event_type: string;
  title: string;
  detail: string;
  metadata_json: string;
  created_at: string;
}

type EventTypeFilter = 'all' | 'knowledge_change' | 'document_import' | 'research_complete' | 'governance_run' | 'vectorization_batch';

// ─── Constants ──────────────────────────────────────────────────────────────

const EVENT_TYPE_FILTERS: { key: EventTypeFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'knowledge_change', label: '知识变动' },
  { key: 'document_import', label: '文档导入' },
  { key: 'research_complete', label: '调研完成' },
  { key: 'governance_run', label: '治理运行' },
  { key: 'vectorization_batch', label: '向量化' },
];

const eventTypeMeta: Record<string, { icon: typeof Activity; accent: string; bg: string; label: string }> = {
  knowledge_change: { icon: BookPlus, accent: 'text-emerald-600', bg: 'bg-emerald-50', label: '知识变动' },
  document_import: { icon: FileInput, accent: 'text-blue-600', bg: 'bg-blue-50', label: '文档导入' },
  research_complete: { icon: SearchCheck, accent: 'text-slate-800', bg: 'bg-slate-100', label: '调研完成' },
  governance_run: { icon: Settings2, accent: 'text-amber-600', bg: 'bg-amber-50', label: '治理运行' },
  vectorization_batch: { icon: Sparkles, accent: 'text-slate-700', bg: 'bg-slate-100', label: '向量化' },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function groupByDate(items: OperationLogEntry[]): Record<string, OperationLogEntry[]> {
  return items.reduce<Record<string, OperationLogEntry[]>>((acc, item) => {
    const dateKey = formatDate(item.created_at);
    acc[dateKey] ||= [];
    acc[dateKey].push(item);
    return acc;
  }, {});
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function OperationLogPage() {
  const [logs, setLogs] = useState<OperationLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<EventTypeFilter>('all');
  const [connectionState, setConnectionState] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected');
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<string>('');

  // Fetch initial data
  const fetchLogs = useCallback(async (type: EventTypeFilter = activeFilter) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ success: boolean; data: { items: OperationLogEntry[]; total: number } }>(
        `/api/v1/operation-logs?type=${type}&limit=100`
      );
      setLogs(res.data.items);
      setTotal(res.data.total);
      if (res.data.items.length > 0) {
        lastEventIdRef.current = String(res.data.items[0].id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [activeFilter]);

  // SSE connection (AC3 + AC4)
  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const url = withBasePath(`/api/v1/operation-logs/stream${lastEventIdRef.current ? `?lastEventId=${lastEventIdRef.current}` : ''}`);
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnectionState('connected');
    };

    es.addEventListener('operation', (e: MessageEvent) => {
      const entry = JSON.parse(e.data) as OperationLogEntry;
      lastEventIdRef.current = String(entry.id);
      setLogs((prev) => {
        // Only add if matches current filter
        if (activeFilter !== 'all' && entry.event_type !== activeFilter) return prev;
        return [entry, ...prev];
      });
      setTotal((prev) => prev + 1);
    });

    es.addEventListener('replay', (e: MessageEvent) => {
      const entries = JSON.parse(e.data) as OperationLogEntry[];
      if (entries.length > 0) {
        lastEventIdRef.current = String(entries[entries.length - 1].id);
        setLogs((prev) => {
          const filtered = activeFilter === 'all'
            ? entries
            : entries.filter((entry) => entry.event_type === activeFilter);
          const existingIds = new Set(prev.map((p) => p.id));
          const newEntries = filtered.filter((e) => !existingIds.has(e.id));
          return [...newEntries.reverse(), ...prev];
        });
      }
    });

    es.addEventListener('init', (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { latestId: number };
      lastEventIdRef.current = String(data.latestId);
    });

    es.onerror = () => {
      setConnectionState('reconnecting');
      es.close();
      // Auto-reconnect after 3s
      setTimeout(() => {
        if (!eventSourceRef.current || eventSourceRef.current.readyState === EventSource.CLOSED) {
          connectSSE();
        }
      }, 3000);
    };
  }, [activeFilter]);

  useEffect(() => {
    fetchLogs();
    connectSSE();
    return () => {
      eventSourceRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconnect when filter changes
  const handleFilterChange = (type: EventTypeFilter) => {
    setActiveFilter(type);
    fetchLogs(type);
  };

  const grouped = groupByDate(logs);
  const dateKeys = Object.keys(grouped);

  if (loading && logs.length === 0) return <ListPageSkeleton />;
  if (error && logs.length === 0) return <ErrorState description={error} onRetry={() => fetchLogs()} />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">操作日志</h1>
          <p className="mt-1 text-sm text-slate-500">
            系统行为的客观记录 · 共 {total} 条
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Connection indicator */}
          <div className="flex items-center gap-1.5 text-xs">
            <Radio className={`h-3 w-3 ${connectionState === 'connected' ? 'text-emerald-500' : connectionState === 'reconnecting' ? 'text-amber-500 animate-pulse' : 'text-slate-300'}`} />
            <span className="text-slate-500">
              {connectionState === 'connected' ? '实时' : connectionState === 'reconnecting' ? '重连中' : '离线'}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={() => fetchLogs()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            刷新
          </Button>
        </div>
      </div>

      {/* Filters (AC2) */}
      <div className="flex flex-wrap gap-2">
        {EVENT_TYPE_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => handleFilterChange(f.key)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              activeFilter === f.key
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Log entries grouped by date (AC2) */}
      {dateKeys.length === 0 ? (
        <EmptyState title="暂无操作日志" description="系统运行产生的事件将在此展示。" />
      ) : (
        <div className="space-y-6">
          {dateKeys.map((dateKey) => (
            <div key={dateKey}>
              <h2 className="mb-3 text-sm font-semibold text-slate-500">{dateKey}</h2>
              <div className="space-y-2">
                {grouped[dateKey].map((entry) => {
                  const meta = eventTypeMeta[entry.event_type] || {
                    icon: Activity,
                    accent: 'text-slate-600',
                    bg: 'bg-slate-50',
                    label: entry.event_type,
                  };
                  const Icon = meta.icon;
                  let parsedMeta: Record<string, string | number | boolean | null> = {};
                  try { parsedMeta = JSON.parse(entry.metadata_json); } catch { /* ignore */ }

                  return (
                    <Card key={entry.id} className="border-slate-100 shadow-none hover:border-slate-200 transition-colors">
                      <CardContent className="flex items-start gap-3 p-4">
                        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${meta.bg}`}>
                          <Icon className={`h-4 w-4 ${meta.accent}`} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-900">{entry.title}</span>
                            <Badge variant="secondary" className="text-[10px]">{meta.label}</Badge>
                          </div>
                          {entry.detail && (
                            <p className="mt-0.5 text-xs text-slate-500">{entry.detail}</p>
                          )}
                          {/* Show metadata highlights */}
                          {Object.keys(parsedMeta).length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {parsedMeta.source && (
                                <span className="text-[10px] text-slate-400">来源: {String(parsedMeta.source)}</span>
                              )}
                              {parsedMeta.count !== undefined && (
                                <span className="text-[10px] text-slate-400">数量: {String(parsedMeta.count)}</span>
                              )}
                              {parsedMeta.report_path && (
                                <span className="text-[10px] text-slate-400">报告: {String(parsedMeta.report_path)}</span>
                              )}
                            </div>
                          )}
                        </div>
                        <span className="shrink-0 text-xs text-slate-400">{formatTime(entry.created_at)}</span>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
