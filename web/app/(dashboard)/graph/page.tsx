'use client';

import { useCallback, useMemo, useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import {
  KnowledgeGraphView,
  type GraphSnapshot,
  type SelectedNode,
  type GraphLayout,
} from '@/components/knowledge-graph/KnowledgeGraphView';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/page-states';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import type { ApiResponse } from '@/types';
import { useCognitiveMode } from '@/contexts/cognitive-mode-context';
import { CognitivePanel } from '@/components/cognitive-panel';
import { MiniBarChart } from '@/components/overview-charts';
import {
  Network,
  X,
  Search,
  SlidersHorizontal,
  ArrowRight,
  ArrowLeft,
  ExternalLink,
  Orbit,
  GitFork,
  Waypoints,
  Link2,
  RefreshCw,
} from 'lucide-react';

// ─── Constants ──────────────────────────────────────────────────────────────

const KNOWLEDGE_TYPES = [
  { value: 'fact', label: '事实', color: '#3B82F6' },
  { value: 'decision', label: '决策', color: '#8B5CF6' },
  { value: 'methodology', label: '方法论', color: '#22C55E' },
  { value: 'experience', label: '经验', color: '#F97316' },
  { value: 'intent', label: '意图', color: '#EF4444' },
  { value: 'meta', label: '元知识', color: '#6B7280' },
];

const EDGE_TYPES = [
  { value: 'supports', label: '支持', color: '#94A3B8' },
  { value: 'depends_on', label: '依赖', color: '#06B6D4' },
  { value: 'conflicts', label: '冲突', color: '#EF4444' },
  { value: 'supersedes', label: '替代', color: '#F59E0B' },
  { value: 'co_occurs', label: '共现', color: '#94A3B8' },
  { value: 'semantic_neighbor', label: '语义邻近', color: '#A855F7' },
];

const TIME_RANGES = [
  { value: '', label: '全部时间' },
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: '90', label: '近 90 天' },
];

const LAYOUT_OPTIONS: { value: GraphLayout; label: string; icon: typeof Network }[] = [
  { value: 'force', label: '力导向', icon: Waypoints },
  { value: 'radial', label: '径向', icon: Orbit },
  { value: 'hierarchy', label: '层级', icon: GitFork },
];

// ─── Page Component ─────────────────────────────────────────────────────────

export default function GraphPage() {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center"><p className="text-muted-foreground">加载中...</p></div>}>
      <GraphPageContent />
    </Suspense>
  );
}

function GraphPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // API filters
  const [domain, setDomain] = useState('');
  const [timeRange, setTimeRange] = useState('');

  // Node selection
  const [selectedNode, setSelectedNode] = useState<SelectedNode | null>(null);

  // Control panel state
  const [graphSearch, setGraphSearch] = useState('');
  const [depthLimit, setDepthLimit] = useState(1);
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<Set<string>>(new Set());
  const [visibleNodeTypes, setVisibleNodeTypes] = useState<Set<string>>(new Set());
  const [showControls, setShowControls] = useState(true);
  const { isFocus, isOverview } = useCognitiveMode();
  const [graphLayout, setGraphLayout] = useState<GraphLayout>('force');

  // Link creation confirm
  const [pendingLink, setPendingLink] = useState<{ sourceId: string; targetId: string } | null>(null);

  // Focus from URL param (e.g. /graph?focus=abc)
  const focusFromUrl = searchParams.get('focus');
  const [focusNodeId, setFocusNodeId] = useState<string | null>(focusFromUrl);

  useEffect(() => {
    if (focusFromUrl) setFocusNodeId(focusFromUrl);
  }, [focusFromUrl]);

  // API URL
  const apiUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (domain) params.set('domain', domain);
    if (timeRange) {
      const since = new Date(Date.now() - parseInt(timeRange) * 86400000);
      params.set('since', since.toISOString());
    }
    const qs = params.toString();
    return `/api/v1/graph${qs ? `?${qs}` : ''}`;
  }, [domain, timeRange]);

  const { data, isLoading, error, mutate } = useApi<ApiResponse<GraphSnapshot>>(apiUrl);
  const [retrying, setRetrying] = useState(false);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    try {
      await mutate();
    } finally {
      setRetrying(false);
    }
  }, [mutate]);
  const domains = useMemo(() => {
    if (!data?.data?.nodes) return [];
    return [...new Set(data.data.nodes.map((n) => n.domain).filter(Boolean))] as string[];
  }, [data]);

  // Search matching node IDs
  const searchHighlightIds = useMemo(() => {
    if (!graphSearch.trim() || !data?.data?.nodes) return new Set<string>();
    const q = graphSearch.toLowerCase();
    const ids = new Set<string>();
    for (const n of data.data.nodes) {
      if (
        n.title.toLowerCase().includes(q) ||
        (n.summary && n.summary.toLowerCase().includes(q)) ||
        n.type.toLowerCase().includes(q) ||
        (n.domain && n.domain.toLowerCase().includes(q))
      ) {
        ids.add(n.id);
      }
    }
    return ids;
  }, [graphSearch, data]);

  // Handlers
  const handleNodeClick = useCallback((node: SelectedNode) => {
    setSelectedNode(node);
    setFocusNodeId(node.id);
  }, []);

  const handleNodeDoubleClick = useCallback(
    (nodeId: string) => {
      router.push(`/knowledge/${nodeId.replace(/^node-/, '')}`);
    },
    [router],
  );

  const handleClearFocus = useCallback(() => {
    setFocusNodeId(null);
    setSelectedNode(null);
  }, []);

  const handleCreateLink = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setPendingLink({ sourceId, targetId });
  }, []);

  const handleConfirmLink = useCallback(async () => {
    if (!pendingLink) return;
    const srcId = pendingLink.sourceId.replace(/^node-/, '');
    const tgtId = pendingLink.targetId.replace(/^node-/, '');
    if (srcId === tgtId) { setPendingLink(null); return; }
    try {
      await apiFetch(`/api/v1/knowledge/${srcId}/link`, {
        method: 'POST',
        body: JSON.stringify({ targetId: tgtId }),
      });
      mutate();
    } catch {
      // toast would be ideal but not imported; link dialog closes, user retries
    }
    setPendingLink(null);
  }, [pendingLink, mutate]);

  const toggleEdgeType = useCallback((edgeType: string) => {
    setVisibleEdgeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(edgeType)) {
        next.delete(edgeType);
      } else {
        next.add(edgeType);
      }
      return next;
    });
  }, []);

  const toggleNodeType = useCallback((nodeType: string) => {
    setVisibleNodeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeType)) {
        next.delete(nodeType);
      } else {
        next.add(nodeType);
      }
      return next;
    });
  }, []);

  if (error) return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-50 text-red-500 dark:bg-red-900/20 dark:text-red-400">
        <Network className="h-6 w-6" />
      </div>
      <div className="text-center space-y-2">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">图谱数据加载失败</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md">{error.message || '无法获取图谱数据，请检查网络连接。'}</p>
      </div>
      <button
        onClick={handleRetry}
        disabled={retrying}
        className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors disabled:opacity-50"
      >
        <RefreshCw className={`h-4 w-4 ${retrying ? 'animate-spin' : ''}`} />
        {retrying ? '重试中...' : '重新加载'}
      </button>
    </div>
  );

  const snapshot = data?.data;
  return (
    <div className="flex h-full flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Network className="h-5 w-5 text-indigo-500 dark:text-indigo-400" />
          <h1 className="text-lg font-semibold text-slate-900 dark:text-white">知识图谱</h1>
          {snapshot && (
            <span className="text-xs text-slate-400 dark:text-slate-500">
              {snapshot.nodes.length} 节点 · {snapshot.edges.length} 关联
            </span>
          )}
          {focusNodeId && (
            <button
              onClick={handleClearFocus}
              className="ml-2 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 transition-colors shadow-sm"
            >
              <Orbit className="h-3.5 w-3.5" />
              返回全局视图
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowControls((v) => !v)}
            className={`rounded-md p-1.5 transition-colors ${showControls ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300' : 'text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300'}`}
            aria-label="切换控制面板"
          >
            <SlidersHorizontal className="h-4 w-4" />
          </button>
          <Select value={domain || '__all__'} onValueChange={v => setDomain(v === '__all__' ? '' : v)}>
            <SelectTrigger className="w-[140px]" aria-label="按域筛选"><SelectValue placeholder="全部域" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部域</SelectItem>
              {domains.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={timeRange || '__all__'} onValueChange={v => setTimeRange(v === '__all__' ? '' : v)}>
            <SelectTrigger className="w-[120px]" aria-label="按时间筛选"><SelectValue placeholder="全部时间" /></SelectTrigger>
            <SelectContent>
              {TIME_RANGES.map(t => <SelectItem key={t.value || '__all__'} value={t.value || '__all__'}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col md:flex-row gap-4 min-h-0">
        {/* Left: Control Panel — hidden in Focus mode */}
        {showControls && !isFocus && (
          <div className="order-2 md:order-none md:w-64 md:shrink-0 md:overflow-y-auto max-h-64 md:max-h-none overflow-y-auto grid grid-cols-2 md:grid-cols-1 gap-4 md:space-y-4 md:gap-0">
            {/* Search */}
            <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <label className="mb-2 block text-xs font-medium text-slate-500 uppercase tracking-wider dark:text-slate-400">
                图谱搜索
              </label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <Input
                  className="h-8 pl-8 text-sm rounded-md"
                  placeholder="搜索节点..."
                  value={graphSearch}
                  onChange={(e) => setGraphSearch(e.target.value)}
                  aria-label="图谱内搜索"
                />
              </div>
              {graphSearch && searchHighlightIds.size > 0 && (
                <p className="mt-1.5 text-[10px] text-slate-400 dark:text-slate-500">
                  匹配 {searchHighlightIds.size} 个节点
                </p>
              )}
              {graphSearch && searchHighlightIds.size === 0 && (
                <p className="mt-1.5 text-[10px] text-slate-400 dark:text-slate-500">无匹配节点</p>
              )}
            </div>

            {/* Depth slider */}
            <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <label className="mb-2 block text-xs font-medium text-slate-500 uppercase tracking-wider dark:text-slate-400">
                邻居深度
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={1}
                  value={depthLimit}
                  onChange={(e) => setDepthLimit(parseInt(e.target.value))}
                  className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-slate-200 accent-indigo-600 dark:bg-slate-700"
                  aria-label="邻居深度"
                />
                <span className="w-6 text-center text-sm font-medium text-slate-700 dark:text-slate-300">
                  {depthLimit}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">
                选中节点后显示 {depthLimit} 跳邻居
              </p>
            </div>

            {/* Edge type filter */}
            <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <label className="mb-2 block text-xs font-medium text-slate-500 uppercase tracking-wider dark:text-slate-400">
                关系类型
              </label>
              <div className="space-y-1.5">
                {EDGE_TYPES.map((et) => (
                  <label
                    key={et.value}
                    className="flex items-center gap-2 cursor-pointer group"
                  >
                    <input
                      type="checkbox"
                      checked={visibleEdgeTypes.size === 0 || visibleEdgeTypes.has(et.value)}
                      onChange={() => toggleEdgeType(et.value)}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-800"
                    />
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: et.color }}
                    />
                    <span className="text-xs text-slate-600 group-hover:text-slate-900 dark:text-slate-400 dark:group-hover:text-slate-200">
                      {et.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Node type filter */}
            <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <label className="mb-2 block text-xs font-medium text-slate-500 uppercase tracking-wider dark:text-slate-400">
                节点类型
              </label>
              <div className="space-y-1.5">
                {KNOWLEDGE_TYPES.map((kt) => (
                  <label
                    key={kt.value}
                    className="flex items-center gap-2 cursor-pointer group"
                  >
                    <input
                      type="checkbox"
                      checked={visibleNodeTypes.size === 0 || visibleNodeTypes.has(kt.value)}
                      onChange={() => toggleNodeType(kt.value)}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-800"
                    />
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: kt.color }}
                    />
                    <span className="text-xs text-slate-600 group-hover:text-slate-900 dark:text-slate-400 dark:group-hover:text-slate-200">
                      {kt.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Center: Graph */}
        <div className="flex-1 rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden relative order-1 md:order-none dark:border-slate-700 dark:bg-slate-900 min-h-[300px]">
          {/* Layout toggle removed — force layout only */}
          {/* Shift+drag hint */}
          <div className="absolute bottom-2 left-2 z-20">
            <span className="inline-flex items-center gap-1 rounded-md bg-slate-100/80 px-2 py-0.5 text-[10px] text-slate-400 backdrop-blur-sm dark:bg-slate-800/80 dark:text-slate-500">
              <Link2 className="h-3 w-3" />
              Shift + 拖拽节点创建链接
            </span>
          </div>
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10 dark:bg-slate-900/80">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600 dark:border-indigo-800 dark:border-t-indigo-400" />
            </div>
          )}
          {snapshot && snapshot.nodes.length > 0 && (
            <KnowledgeGraphView
              snapshot={snapshot}
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              onCreateLink={handleCreateLink}
              className="w-full h-full"
              searchHighlightIds={searchHighlightIds.size > 0 ? searchHighlightIds : undefined}
              focusNodeId={focusNodeId}
              depthLimit={depthLimit}
              visibleEdgeTypes={visibleEdgeTypes.size > 0 ? visibleEdgeTypes : undefined}
              visibleNodeTypes={visibleNodeTypes.size > 0 ? visibleNodeTypes : undefined}
              layout={graphLayout}
            />
          )}
          {snapshot && snapshot.nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <EmptyState
                icon={Network}
                title="图谱还没有节点"
                description="录入知识条目并建立关联后，图谱会自动生成。先去知识库添加第一批条目吧。"
                primaryAction={{ label: '前往知识库', href: '/knowledge' }}
              />
            </div>
          )}
        </div>

        {/* Right: Node Detail Card */}
        {selectedNode && (
          <Card className="order-3 md:order-none w-full md:w-72 md:shrink-0 overflow-y-auto shadow-sm dark:border-slate-700 dark:bg-slate-900 max-h-64 md:max-h-none">
            <CardHeader className="pb-2 flex flex-row items-start justify-between">
              <CardTitle className="text-sm font-medium text-slate-900 dark:text-white">{selectedNode.title}</CardTitle>
              <button
                onClick={() => {
                  setSelectedNode(null);
                  setFocusNodeId(null);
                }}
                className="text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                aria-label="关闭详情"
              >
                <X className="h-4 w-4" />
              </button>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {/* Type + Domain badges */}
              <div className="flex flex-wrap gap-2">
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                  style={{
                    backgroundColor:
                      KNOWLEDGE_TYPES.find((t) => t.value === selectedNode.type)?.color ?? '#6B7280',
                  }}
                >
                  {KNOWLEDGE_TYPES.find((t) => t.value === selectedNode.type)?.label ?? selectedNode.type}
                </span>
                {selectedNode.domain && (
                  <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] text-slate-600 dark:text-slate-400 dark:border-slate-600">
                    {selectedNode.domain}
                  </span>
                )}
                {selectedNode.connectionCount != null && (
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                    {selectedNode.connectionCount} 个关联
                  </span>
                )}
              </div>

              {/* Summary */}
              <p className="text-slate-600 leading-relaxed dark:text-slate-300">{selectedNode.summary}</p>
              <p className="text-[10px] text-slate-400 dark:text-slate-500">来源: {selectedNode.sourceRef}</p>

              {/* Relations list */}
              {selectedNode.relations && selectedNode.relations.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider dark:text-slate-400">
                    关联节点
                  </p>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {selectedNode.relations.map((rel) => (
                      <button
                        key={`${rel.id}-${rel.edgeType}-${rel.direction}`}
                        onClick={() => {
                          setFocusNodeId(rel.id);
                        }}
                        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-slate-600 hover:bg-slate-50 transition-colors dark:text-slate-400 dark:hover:bg-slate-800"
                      >
                        {rel.direction === 'outgoing' ? (
                          <ArrowRight className="h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500" />
                        ) : (
                          <ArrowLeft className="h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500" />
                        )}
                        <span
                          className="h-1.5 w-1.5 rounded-full shrink-0"
                          style={{
                            backgroundColor:
                              KNOWLEDGE_TYPES.find((t) => t.value === rel.type)?.color ?? '#6B7280',
                          }}
                        />
                        <span className="truncate flex-1">{rel.title}</span>
                        <span className="text-[9px] text-slate-400 shrink-0 dark:text-slate-500">
                          {EDGE_TYPES.find((et) => et.value === rel.edgeType)?.label ?? rel.edgeType}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Action button */}
              <button
                onClick={() => handleNodeDoubleClick(selectedNode.id)}
                className="w-full rounded-md bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 transition-colors inline-flex items-center justify-center gap-1.5 dark:bg-indigo-900/30 dark:text-indigo-300 dark:hover:bg-indigo-900/50"
              >
                <ExternalLink className="h-3 w-3" />
                查看详情
              </button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Overview mode: Node density by type */}
      <CognitivePanel visible={isOverview}>
        {snapshot && (
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">节点类型分布</p>
            <MiniBarChart
              width={240}
              height={56}
              data={KNOWLEDGE_TYPES.map((t) => ({
                label: t.label,
                value: snapshot.nodes.filter((n) => n.type === t.value).length,
                color: t.color,
              }))}
              ariaLabel="节点类型分布"
            />
          </div>
        )}
      </CognitivePanel>

      {/* Link creation confirmation dialog */}
      {pendingLink && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-lg border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-600 dark:bg-slate-800">
            <div className="flex items-center gap-2 mb-3">
              <Link2 className="h-4 w-4 text-indigo-500" />
              <h3 className="text-sm font-medium text-slate-900 dark:text-white">创建链接？</h3>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed mb-4 dark:text-slate-400">
              将在源节点内容中追加 <code className="rounded bg-slate-100 px-1 py-0.5 text-[10px] dark:bg-slate-700">[[目标标题]]</code> 链接。
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setPendingLink(null)}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors dark:text-slate-400 dark:hover:bg-slate-700"
              >
                取消
              </button>
              <button
                onClick={handleConfirmLink}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 transition-colors"
              >
                确认创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
