'use client';

import { useCallback, useState } from 'react';
import {
  CheckCircle2, XCircle, Pencil, ClipboardCheck, Inbox,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/client-api';
import type { ApiResponse } from '@/types';
import type { KnowledgeEntry } from '@self-evolving-harness/kivo';

const TYPE_LABELS: Record<string, string> = {
  fact: '事实',
  methodology: '方法论',
  decision: '决策',
  experience: '经验',
  intent: '意图',
  meta: '元知识',
};

const TYPE_COLORS: Record<string, string> = {
  fact: 'bg-blue-100 text-blue-700',
  methodology: 'bg-purple-100 text-purple-700',
  decision: 'bg-amber-100 text-amber-700',
  experience: 'bg-emerald-100 text-emerald-700',
  intent: 'bg-rose-100 text-rose-700',
  meta: 'bg-slate-100 text-slate-700',
};

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-20 rounded-full bg-slate-200">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{pct}%</span>
    </div>
  );
}

function ReviewCard({
  entry,
  onAction,
}: {
  entry: KnowledgeEntry;
  onAction: (id: string, action: 'approve' | 'reject' | 'edit', content?: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(entry.content);
  const [loading, setLoading] = useState(false);

  const handleAction = async (action: 'approve' | 'reject' | 'edit', content?: string) => {
    setLoading(true);
    try {
      await onAction(entry.id, action, content);
    } finally {
      setLoading(false);
      setEditing(false);
    }
  };

  const sourceLabel = entry.source
    ? `${entry.source.type} · ${entry.source.reference}`
    : '未知来源';

  const extractedAt = entry.createdAt
    ? new Date(entry.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <Card className="border-slate-200/80 bg-white shadow-sm transition-all hover:shadow-md">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0 space-y-1">
            <CardTitle className="text-base font-semibold text-slate-900 truncate">
              {entry.title}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={`text-[10px] ${TYPE_COLORS[entry.type] || TYPE_COLORS.meta}`}>
                {TYPE_LABELS[entry.type] || entry.type}
              </Badge>
              <span className="text-xs text-muted-foreground">{sourceLabel}</span>
              <span className="text-xs text-muted-foreground">{extractedAt}</span>
            </div>
          </div>
          <ConfidenceBar value={entry.confidence} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="min-h-[100px] text-sm"
              aria-label="编辑知识内容"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => handleAction('edit', editContent)}
                disabled={loading || !editContent.trim()}
              >
                确认保存
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setEditing(false); setEditContent(entry.content); }}
                disabled={loading}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-700 whitespace-pre-wrap line-clamp-4">
              {entry.summary || entry.content}
            </p>
            {entry.content !== entry.summary && entry.summary && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer hover:text-slate-600">展开完整内容</summary>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">
                  {entry.content}
                </p>
              </details>
            )}
          </>
        )}

        {!editing && (
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              className="text-emerald-600 border-emerald-200 hover:bg-emerald-50 hover:border-emerald-300"
              onClick={() => handleAction('approve')}
              disabled={loading}
              aria-label="确认通过"
            >
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
              确认
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-red-600 border-red-200 hover:bg-red-50 hover:border-red-300"
              onClick={() => handleAction('reject')}
              disabled={loading}
              aria-label="拒绝"
            >
              <XCircle className="mr-1.5 h-4 w-4" />
              拒绝
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
              disabled={loading}
              aria-label="编辑后确认"
            >
              <Pencil className="mr-1.5 h-4 w-4" />
              编辑
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ReviewPage() {
  const { data, error, isLoading, mutate } = useApi<ApiResponse<KnowledgeEntry[]>>(
    '/api/v1/knowledge?status=pending&pageSize=50&sort=-createdAt'
  );

  const entries = data?.data ?? [];
  const total = data?.meta?.total ?? 0;

  const handleReview = useCallback(
    async (id: string, action: 'approve' | 'reject' | 'edit', content?: string) => {
      try {
        await apiFetch(`/api/v1/knowledge/${id}/review`, {
          method: 'PATCH',
          body: JSON.stringify({ action, content }),
        });

        const actionLabel = action === 'approve' ? '已确认' : action === 'reject' ? '已拒绝' : '已编辑并确认';
        toast.success(actionLabel);

        // Remove the reviewed entry from the list optimistically
        mutate(
          (prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              data: prev.data.filter((e) => e.id !== id),
              meta: prev.meta ? { ...prev.meta, total: prev.meta.total - 1 } : undefined,
            };
          },
          { revalidate: false }
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '操作失败');
      }
    },
    [mutate]
  );

  if (isLoading) return <ListPageSkeleton rows={4} filters={0} />;
  if (error) return <ErrorState onRetry={() => mutate()} />;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <ClipboardCheck className="h-6 w-6 text-indigo-500" />
          <h1 className="text-2xl font-bold text-slate-900">萃取审核</h1>
          {total > 0 && (
            <Badge variant="secondary" className="text-xs">
              {total} 条待审核
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          低置信度的知识萃取结果需要人工审核确认后才会进入知识库。
        </p>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="暂无待审核条目"
          description="所有萃取结果已审核完毕，或当前没有低置信度的萃取结果。"
        />
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => (
            <ReviewCard key={entry.id} entry={entry} onAction={handleReview} />
          ))}
        </div>
      )}
    </div>
  );
}
