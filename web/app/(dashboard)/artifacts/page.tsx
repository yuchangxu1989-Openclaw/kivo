'use client';

import { useCallback, useState } from 'react';
import {
  CheckCircle2, XCircle, Pencil, FileSearch, AlertTriangle, Layers,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/client-api';
import type { ApiResponse } from '@/types';

interface ArtifactListItem {
  id: string;
  sourceId: string;
  status: 'pending_review' | 'approved' | 'rejected' | 'ready';
  confidence: number;
  claimsCount: number;
  entityCount: number;
  conceptCount: number;
  conflictCount: number;
  gapCount: number;
  researchQueryCount: number;
  reviewProgress: { total: number; reviewed: number };
  createdAt: string;
  updatedAt: string;
}

interface ArtifactDetail extends ArtifactListItem {
  extractedClaims: Array<{ id: string; text: string; confidence: number; type?: string }>;
  entityCandidates: Array<{ id: string; label: string; confidence: number }>;
  conceptCandidates: Array<{ id: string; label: string; confidence: number }>;
  linkCandidates: Array<{ id: string; label: string; confidence: number }>;
  conflictCandidates: Array<{ id: string; label: string; confidence: number }>;
  gapCandidates: Array<{ id: string; label: string; confidence: number }>;
  recommendedResearchQueries: string[];
  candidateDecisions: Array<{
    candidateId: string;
    action: 'approved' | 'rejected' | 'edited';
    editedValue?: string;
    reviewedAt: string;
  }>;
}

const STATUS_LABELS: Record<string, string> = {
  pending_review: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
  ready: '就绪',
};

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending_review: 'outline',
  approved: 'default',
  rejected: 'destructive',
  ready: 'secondary',
};

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-16 rounded-full bg-slate-200 dark:bg-slate-700">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{pct}%</span>
    </div>
  );
}

function ReviewPanel({
  artifact,
  onReview,
}: {
  artifact: ArtifactDetail;
  onReview: (candidateId: string, action: 'approved' | 'rejected' | 'edited', editedValue?: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const decidedIds = new Set(artifact.candidateDecisions.map(d => d.candidateId));

  const allCandidates = [
    ...artifact.extractedClaims.map(c => ({ id: c.id, label: c.text, confidence: c.confidence, section: '提取声明' })),
    ...artifact.entityCandidates.map(c => ({ ...c, section: '实体候选' })),
    ...artifact.conceptCandidates.map(c => ({ ...c, section: '概念候选' })),
    ...artifact.conflictCandidates.map(c => ({ ...c, section: '冲突候选' })),
    ...artifact.gapCandidates.map(c => ({ ...c, section: '缺口候选' })),
  ];

  const pending = allCandidates.filter(c => !decidedIds.has(c.id));
  const decided = allCandidates.filter(c => decidedIds.has(c.id));

  return (
    <div className="space-y-4">
      {pending.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-slate-700 dark:text-slate-300">待审核 ({pending.length})</h4>
          {pending.map(c => (
            <div key={c.id} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800">
              <div className="flex-1 min-w-0">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{c.section}</span>
                {editingId === c.id ? (
                  <div className="mt-1 flex gap-2">
                    <Input
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      className="h-8 text-sm"
                      aria-label="编辑候选内容"
                    />
                    <Button size="sm" variant="outline" onClick={() => { onReview(c.id, 'edited', editValue); setEditingId(null); }}>
                      确认
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>取消</Button>
                  </div>
                ) : (
                  <p className="text-sm text-slate-800 dark:text-slate-200 truncate">{c.label}</p>
                )}
                <ConfidenceBar value={c.confidence} />
              </div>
              {editingId !== c.id && (
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-emerald-600 hover:bg-emerald-50" onClick={() => onReview(c.id, 'approved')} aria-label="确认">
                    <CheckCircle2 className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-red-600 hover:bg-red-50" onClick={() => onReview(c.id, 'rejected')} aria-label="拒绝">
                    <XCircle className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-slate-600 hover:bg-slate-50" onClick={() => { setEditingId(c.id); setEditValue(c.label); }} aria-label="编辑">
                    <Pencil className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {decided.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-slate-500 dark:text-slate-400">已审核 ({decided.length})</h4>
          {decided.map(c => {
            const decision = artifact.candidateDecisions.find(d => d.candidateId === c.id);
            return (
              <div key={c.id} className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{c.section}</span>
                  <p className="text-sm text-slate-600 dark:text-slate-400 truncate">{decision?.editedValue || c.label}</p>
                </div>
                <Badge variant={decision?.action === 'approved' ? 'default' : decision?.action === 'rejected' ? 'destructive' : 'secondary'}>
                  {decision?.action === 'approved' ? '已确认' : decision?.action === 'rejected' ? '已拒绝' : '已编辑'}
                </Badge>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function ArtifactsPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (statusFilter) params.set('status', statusFilter);

  const { data, isLoading, error, mutate } = useApi<ApiResponse<ArtifactListItem[]>>(
    `/api/v1/artifacts?${params.toString()}`,
  );
  const artifacts = data?.data ?? [];

  const { data: detailData, mutate: mutateDetail } = useApi<{ data: ArtifactDetail }>(
    expandedId ? `/api/v1/artifacts/${expandedId}/review` : null,
  );
  const detail = detailData?.data;

  const handleReview = useCallback(async (candidateId: string, action: string, editedValue?: string) => {
    if (!expandedId) return;
    try {
      await apiFetch(`/api/v1/artifacts/${expandedId}/review`, {
        method: 'POST',
        body: JSON.stringify({ candidateId, action, editedValue }),
      });
      toast.success(action === 'approved' ? '已确认' : action === 'rejected' ? '已拒绝' : '已编辑保存');
      void mutateDetail();
      void mutate();
    } catch (err) {
      toast.error(`操作失败: ${(err as Error).message}`);
    }
  }, [expandedId, mutate, mutateDetail]);

  if (isLoading) return <ListPageSkeleton filters={2} rows={4} />;
  if (error) return <ErrorState title="分析产物加载失败" description={error.message} onRetry={() => void mutate()} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950 dark:text-white">分析产物审核</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            审核分析管线产出的候选实体、概念、冲突和缺口。确认、拒绝或编辑后入库。
          </p>
        </div>
        <Select value={statusFilter || 'all'} onValueChange={v => setStatusFilter(v === 'all' ? '' : v)}>
          <SelectTrigger className="w-[160px]" aria-label="按状态筛选">
            <SelectValue placeholder="全部状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="pending_review">待审核</SelectItem>
            <SelectItem value="approved">已通过</SelectItem>
            <SelectItem value="rejected">已拒绝</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {artifacts.length === 0 ? (
        <EmptyState
          icon={FileSearch}
          title="暂无分析产物"
          description="分析管线运行后会在此展示待审核的候选知识。"
        />
      ) : (
        <div className="space-y-3">
          {artifacts.map(art => (
            <Card
              key={art.id}
              className={`cursor-pointer transition-all hover:border-indigo-200 dark:hover:border-indigo-600 ${expandedId === art.id ? 'border-indigo-300 ring-1 ring-indigo-200 dark:border-indigo-500 dark:ring-indigo-800' : ''}`}
              onClick={() => setExpandedId(expandedId === art.id ? null : art.id)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Layers className="h-5 w-5 text-indigo-500" />
                    <CardTitle className="text-base">来源: {art.sourceId}</CardTitle>
                    <Badge variant={STATUS_VARIANT[art.status]}>{STATUS_LABELS[art.status]}</Badge>
                  </div>
                  <ConfidenceBar value={art.confidence} />
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span>声明 {art.claimsCount}</span>
                  <span>实体 {art.entityCount}</span>
                  <span>概念 {art.conceptCount}</span>
                  {art.conflictCount > 0 && (
                    <span className="flex items-center gap-1 text-amber-600">
                      <AlertTriangle className="h-3 w-3" />冲突 {art.conflictCount}
                    </span>
                  )}
                  <span>缺口 {art.gapCount}</span>
                  <span>审核进度 {art.reviewProgress.reviewed}/{art.reviewProgress.total}</span>
                  <span>{new Date(art.createdAt).toLocaleDateString('zh-CN')}</span>
                </div>
                {expandedId === art.id && detail && (
                  <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800" onClick={e => e.stopPropagation()}>
                    <ReviewPanel artifact={detail} onReview={handleReview} />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
