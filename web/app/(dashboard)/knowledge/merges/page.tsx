'use client';

import { useState } from 'react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import { AlertTriangle, Calendar, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import type { ApiResponse } from '@/types';

interface MergeSnapshot {
  merge_id: string;
  merged_entry_json: string;
  original_entries_json: string;
  created_at: string;
}

interface MergeListData {
  snapshots: MergeSnapshot[];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function MergeRow({ snapshot, onRollback }: { snapshot: MergeSnapshot; onRollback: (id: string) => void }) {
  const [loading, setLoading] = useState(false);
  const [rolledBack, setRolledBack] = useState(false);

  let mergedTitle = '未命名合并';
  try {
    const parsed = JSON.parse(snapshot.merged_entry_json);
    mergedTitle = parsed.title || parsed.id || mergedTitle;
  } catch { /* ignore */ }

  let originalCount = 0;
  try {
    const parsed = JSON.parse(snapshot.original_entries_json);
    originalCount = Array.isArray(parsed) ? parsed.length : 0;
  } catch { /* ignore */ }

  const handleRollback = async () => {
    setLoading(true);
    try {
      await apiFetch(`/api/v1/knowledge/merge/${snapshot.merge_id}/rollback`, {
        method: 'POST',
      });
      setRolledBack(true);
      onRollback(snapshot.merge_id);
    } catch {
      // Error handled silently — button stays enabled for retry
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="border-slate-200/80 bg-white/95 shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-slate-900 truncate">
              {mergedTitle}
            </h3>
            <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {formatDate(snapshot.created_at)}
              </span>
              <span>合并了 {originalCount} 条原始条目</span>
            </div>
          </div>
          <div className="shrink-0">
            {rolledBack ? (
              <Badge variant="outline" className="text-emerald-600">已回退</Badge>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={handleRollback}
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                {loading ? '回退中...' : '回退'}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function KnowledgeMergesPage() {
  const { data, isLoading, error, mutate } = useApi<ApiResponse<MergeListData>>('/api/v1/knowledge/merges');

  if (isLoading) return <ListPageSkeleton rows={4} />;

  if (error) {
    return (
      <ErrorState
        title="合并记录加载失败"
        description={error.message || '暂时无法获取合并历史。'}
        onRetry={() => void mutate()}
      />
    );
  }

  const snapshots = data?.data?.snapshots ?? [];

  if (snapshots.length === 0) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="暂无合并记录"
        description="知识库尚未执行过条目合并操作。合并操作会在治理流程中自动触发。"
        primaryAction={{ label: '返回知识库', href: '/knowledge' }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">合并历史</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          知识条目合并的历史记录。如果合并结果不理想，可以回退到合并前的状态。
        </p>
      </div>

      <div className="space-y-3">
        {snapshots.map((snapshot) => (
          <MergeRow
            key={snapshot.merge_id}
            snapshot={snapshot}
            onRollback={() => void mutate()}
          />
        ))}
      </div>
    </div>
  );
}
