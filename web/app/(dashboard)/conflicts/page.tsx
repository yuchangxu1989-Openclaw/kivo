'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { useApi } from '@/hooks/use-api';
import { computeWordDiff, type DiffSegment } from '@/lib/word-diff';
import { CheckCircle2, ArrowRight, Loader2, Merge, Trash2, MessageSquare, ChevronDown, ChevronUp, FileText, Clock, Link2, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ErrorState, ListPageSkeleton, EmptyState } from '@/components/ui/page-states';
import { OnboardingGuideCard } from '@/components/onboarding-guide-card';
import { useWorkbenchStore } from '@/lib/workbench-store';
import type { ApiResponse } from '@/types';
import { apiFetch } from '@/lib/client-api';
import { TYPE_LABELS, typeLabel } from '@/lib/i18n-labels';

interface ConflictEntry {
  id: string;
  content: string;
  type: string;
  confidence?: number;
  sourceType?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface Conflict {
  id: string;
  entryA: ConflictEntry;
  entryB: ConflictEntry;
  status: 'unresolved' | 'resolved';
  similarity?: number;
  createdAt: string;
  version: number;
  resolution?: { strategy: string; reason?: string; resolvedAt?: string };
  relatedEntryCount?: number;
  affectedEntryIds?: string[];
}

function DiffText({ segments }: { segments: DiffSegment[] }) {
  return (
    <p className="text-sm leading-relaxed">
      {segments.map((seg, i) => (
        <span
          key={i}
          className={
            seg.type === 'removed' ? 'bg-red-100 text-red-800 line-through dark:bg-red-900/40 dark:text-red-300' :
            seg.type === 'added' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' : ''
          }
        >{seg.text}</span>
      ))}
    </p>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  '对话提取': '对话提取',
  '文档导入': '文档导入',
  '手动录入': '手动录入',
};

function ConflictCard({ conflict, resolving, onResolve }: {
  conflict: Conflict;
  resolving: boolean;
  onResolve: (strategy: string, winnerId?: string, reason?: string, mergedContent?: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [showMergeEditor, setShowMergeEditor] = useState(false);
  const [mergedContent, setMergedContent] = useState('');
  const [showEvidence, setShowEvidence] = useState(false);
  const diff = computeWordDiff(conflict.entryA.content, conflict.entryB.content);

  function validateAndResolve(strategy: string, winnerId?: string) {
    if (!reason.trim()) {
      setReasonError(true);
      return;
    }
    setReasonError(false);
    if (strategy === 'merge') {
      onResolve(strategy, winnerId, reason.trim(), mergedContent.trim() || undefined);
    } else {
      onResolve(strategy, winnerId, reason.trim());
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">冲突 #{conflict.id.slice(0, 8)}</CardTitle>
          <div className="flex items-center gap-2">
            {conflict.similarity != null && (
              <Badge variant="outline">相似度 {(conflict.similarity * 100).toFixed(0)}%</Badge>
            )}
            {conflict.relatedEntryCount != null && conflict.relatedEntryCount > 0 && (
              <Badge variant="outline" className="gap-1">
                <Link2 className="h-3 w-3" />
                影响 {conflict.relatedEntryCount} 条
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">{new Date(conflict.createdAt).toLocaleDateString('zh-CN')}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 space-y-2 dark:border-slate-700 dark:bg-slate-800/50">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{TYPE_LABELS[conflict.entryA.type] ?? conflict.entryA.type}</Badge>
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">条目 A</span>
              {conflict.entryA.confidence != null && (
                <span className="ml-auto text-xs text-muted-foreground">置信度 {(conflict.entryA.confidence * 100).toFixed(0)}%</span>
              )}
            </div>
            <DiffText segments={diff.left} />
            {conflict.entryA.sourceType && (
              <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <FileText className="h-3 w-3" />
                  {SOURCE_LABELS[conflict.entryA.sourceType] ?? conflict.entryA.sourceType}
                </span>
                {conflict.entryA.createdAt && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    创建 {conflict.entryA.createdAt}
                  </span>
                )}
                {conflict.entryA.updatedAt && conflict.entryA.updatedAt !== conflict.entryA.createdAt && (
                  <span className="inline-flex items-center gap-1">
                    更新 {conflict.entryA.updatedAt}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 space-y-2 dark:border-slate-700 dark:bg-slate-800/50">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{TYPE_LABELS[conflict.entryB.type] ?? conflict.entryB.type}</Badge>
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">条目 B</span>
              {conflict.entryB.confidence != null && (
                <span className="ml-auto text-xs text-muted-foreground">置信度 {(conflict.entryB.confidence * 100).toFixed(0)}%</span>
              )}
            </div>
            <DiffText segments={diff.right} />
            {conflict.entryB.sourceType && (
              <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <FileText className="h-3 w-3" />
                  {SOURCE_LABELS[conflict.entryB.sourceType] ?? conflict.entryB.sourceType}
                </span>
                {conflict.entryB.createdAt && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    创建 {conflict.entryB.createdAt}
                  </span>
                )}
                {conflict.entryB.updatedAt && conflict.entryB.updatedAt !== conflict.entryB.createdAt && (
                  <span className="inline-flex items-center gap-1">
                    更新 {conflict.entryB.updatedAt}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Evidence: Related entries */}
        {conflict.relatedEntryCount != null && conflict.relatedEntryCount > 0 && (
          <div className="space-y-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              onClick={() => setShowEvidence(!showEvidence)}
            >
              <Info className="h-3 w-3" />
              关联影响范围（{conflict.relatedEntryCount} 条知识条目）
              {showEvidence ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {showEvidence && conflict.affectedEntryIds && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-800 dark:bg-amber-900/20">
                <p className="text-xs text-amber-800 dark:text-amber-300 mb-2">
                  以下知识条目与冲突双方存在关联，裁决后状态将联动更新：
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {conflict.affectedEntryIds.map((entryId) => (
                    <Link key={entryId} href={`/knowledge/${entryId}`} className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-200 transition-colors dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60">
                      <Link2 className="h-3 w-3" />
                      {entryId}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="space-y-3 border-t pt-3">
          <div className="space-y-1.5">
            <label className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 dark:text-slate-300">
              <MessageSquare className="h-3 w-3" />
              裁决理由 <span className="text-red-500">*</span>
            </label>
            <textarea
              className={`w-full rounded-md border px-3 py-2 text-sm placeholder:text-slate-400 dark:placeholder:text-slate-500 bg-white dark:bg-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 ${reasonError ? 'border-red-400 focus:border-red-400 focus:ring-red-400' : 'border-slate-300 dark:border-slate-600 focus:border-indigo-400 focus:ring-indigo-400'}`}
              rows={2}
              placeholder="请输入裁决原因（必填），方便日后追溯…"
              value={reason}
              onChange={(e) => { setReason(e.target.value); if (e.target.value.trim()) setReasonError(false); }}
            />
            {reasonError && (
              <p className="text-xs text-red-500">请填写裁决理由后再提交</p>
            )}
          </div>

          {showMergeEditor && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-700 dark:text-slate-300">合并内容</label>
              <textarea
                className="w-full rounded-md border border-slate-300 dark:border-slate-600 px-3 py-2 text-sm placeholder:text-slate-400 dark:placeholder:text-slate-500 bg-white dark:bg-slate-800 dark:text-slate-200 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                rows={4}
                placeholder="编辑合并后的最终内容…"
                value={mergedContent}
                onChange={(e) => setMergedContent(e.target.value)}
              />
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={resolving} onClick={() => validateAndResolve('manual', conflict.entryA.id)}>
              {resolving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              采纳 A
            </Button>
            <Button size="sm" disabled={resolving} onClick={() => validateAndResolve('manual', conflict.entryB.id)}>
              {resolving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              采纳 B
            </Button>
            <Button size="sm" variant="outline" disabled={resolving} onClick={() => { if (!showMergeEditor) { setShowMergeEditor(true); setMergedContent(conflict.entryA.content + '\n\n' + conflict.entryB.content); } else { validateAndResolve('merge'); } }}>
              {resolving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Merge className="mr-1.5 h-3.5 w-3.5" />}
              {showMergeEditor ? '确认合并' : '合并'}
            </Button>
            <Button size="sm" variant="outline" disabled={resolving} onClick={() => validateAndResolve('discard-both')}>
              {resolving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
              双废弃
            </Button>
          </div>
          {conflict.relatedEntryCount != null && conflict.relatedEntryCount > 0 && (
            <p className="text-xs text-muted-foreground">
              裁决完成后将联动更新 {conflict.relatedEntryCount} 条关联知识的状态。
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ResolvedCard({ conflict }: { conflict: Conflict }) {
  const strategyLabel: Record<string, string> = {
    manual: '手动选择', merge: '合并双方', 'discard-both': '同时废弃',
    'newer-wins': '新者优先', 'confidence-wins': '置信度优先',
  };
  return (
    <div className="rounded-lg border border-slate-200 bg-white/80 p-4 dark:border-slate-700 dark:bg-slate-800/80">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-700">#{conflict.id.slice(0, 8)}</span>
          <Badge variant="secondary">已解决</Badge>
          {conflict.resolution?.strategy && (
            <span className="text-xs text-muted-foreground">{strategyLabel[conflict.resolution.strategy] ?? conflict.resolution.strategy}</span>
          )}
        </div>
        {conflict.resolution?.resolvedAt && (
          <span className="text-xs text-muted-foreground">{new Date(conflict.resolution.resolvedAt).toLocaleDateString('zh-CN')}</span>
        )}
      </div>
      {conflict.resolution?.reason && (
        <p className="mt-2 text-xs text-slate-500 italic">理由：{conflict.resolution.reason}</p>
      )}
    </div>
  );
}

export default function ConflictResolutionPage() {
  const { data, isLoading, error, mutate } = useApi<ApiResponse<Conflict[]>>('/api/v1/conflicts');
  const conflicts = data?.data ?? [];
  const [resolving, setResolving] = useState<string | null>(null);
  const hasHydrated = useWorkbenchStore((state) => state.hasHydrated);
  const onboardingCompleted = useWorkbenchStore((state) => state.onboardingCompleted);

  const handleResolve = useCallback(async (conflictId: string, strategy: string, winnerId?: string, reason?: string, mergedContent?: string) => {
    setResolving(conflictId);
    try {
      const conflict = conflicts.find(c => c.id === conflictId);
      await apiFetch(`/api/v1/conflicts/${conflictId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategy, winnerId, reason, mergedContent,
          expectedVersion: conflict?.version ?? 1,
          requestId: crypto.randomUUID(),
        }),
      });
      await mutate();
    } finally {
      setResolving(null);
    }
  }, [conflicts, mutate]);

  if (error) {
    return (
      <ErrorState
        title="冲突列表加载失败"
        description={error.message || '暂时拿不到冲突裁决列表。'}
        onRetry={() => void mutate()}
      />
    );
  }
  if (isLoading || !hasHydrated) return <ListPageSkeleton rows={4} />;

  const unresolved = conflicts.filter(c => c.status === 'unresolved');
  const resolved = conflicts.filter(c => c.status === 'resolved');

  return (
    <div className="space-y-6">
      {!onboardingCompleted && <OnboardingGuideCard compact />}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">冲突裁决</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            语义接近但内容相冲突的知识条目。对比差异后选择保留策略，也可以合并或同时废弃。
          </p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-sm font-medium text-slate-700">
          <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">待处理</span>
          <span className="text-base font-semibold text-slate-950">{unresolved.length}</span>
        </div>
      </div>

      {unresolved.length === 0 && (
        <EmptyState
          icon={CheckCircle2}
          title={onboardingCompleted ? '暂无未解决冲突' : '还没有冲突需要裁决'}
          description={
            onboardingCompleted
              ? '系统会在知识写入和更新时持续检查内容冲突。出现异常后，你可以在这里对比条目、选择保留策略。'
              : '先导入首批知识，系统才有机会检测相似但冲突的条目。首用阶段先把内容放进来，后面再来这里做治理。'
          }
          primaryAction={{ label: '返回知识库', href: '/knowledge' }}
          secondaryAction={{ label: '查看总览', href: '/dashboard', variant: 'outline' }}
        />
      )}

      {unresolved.map(conflict => (
        <ConflictCard
          key={conflict.id}
          conflict={conflict}
          resolving={resolving === conflict.id}
          onResolve={(strategy, winnerId, reason, mergedContent) => handleResolve(conflict.id, strategy, winnerId, reason, mergedContent)}
        />
      ))}

      {resolved.length > 0 && (
        <div className="space-y-3 pt-6">
          <h2 className="text-lg font-semibold text-muted-foreground">已解决 ({resolved.length})</h2>
          {resolved.map(conflict => <ResolvedCard key={conflict.id} conflict={conflict} />)}
        </div>
      )}
    </div>
  );
}
