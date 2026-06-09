'use client';

import { useParams, useRouter } from 'next/navigation';
import { useApi } from '@/hooks/use-api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DetailPageSkeleton, ErrorState } from '@/components/ui/page-states';
import { ArrowLeft, Brain, Clock, Hash, MessageSquare, Tag } from 'lucide-react';
import { apiFetch } from '@/lib/client-api';
import { toast } from 'sonner';
import { useState } from 'react';
import type { ApiResponse } from '@/types';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Textarea } from '@/components/ui/textarea';
const SIGNAL_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  correction: { label: '纠偏', color: 'bg-rose-100 text-rose-700' },
  emphasis: { label: '强调', color: 'bg-amber-100 text-amber-700' },
  declaration: { label: '声明', color: 'bg-blue-100 text-blue-700' },
  rule: { label: '规则', color: 'bg-violet-100 text-violet-700' },
  preference: { label: '偏好', color: 'bg-emerald-100 text-emerald-700' },
};

function detectSignalType(description: string): string {
  const lower = description.toLowerCase();
  if (lower.includes('规则') || lower.includes('必须') || lower.includes('禁止')) return 'rule';
  if (lower.includes('偏') || lower.includes('喜欢') || lower.includes('偏好')) return 'preference';
  if (lower.includes('纠') || lower.includes('错') || lower.includes('不')) return 'correction';
  if (lower.includes('强') || lower.includes('关键') || lower.includes('重要')) return 'emphasis';
  return 'declaration';
}

export default function IntentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;
  const { data, isLoading, error, mutate } = useApi<ApiResponse<Record<string, unknown>>>(`/api/v1/intent/${id}`);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingWhy, setEditingWhy] = useState(false);
  const [whyDraft, setWhyDraft] = useState('');
  const [editingSimilar, setEditingSimilar] = useState(false);
  const [similarDraft, setSimilarDraft] = useState('');
  const intent = data?.data as Record<string, unknown> | undefined;
  const name = intent?.name as string || '';
  const description = intent?.description as string || '';
  const why = intent?.why as string | undefined || '';
  const similarSentences = (intent?.similarSentences as string[]) || [];
  const recentHitCount = (intent?.recentHitCount as number) || 0;
  const updatedAt = (intent?.updatedAt as string) || '';
  const createdAt = (intent?.createdAt as string) || '';
  const sourceSessionId = intent?.sourceSessionId as string | undefined;
  const confidence = (intent?.confidence as number) ?? 1;

  const signalType = detectSignalType(description);

  if (isLoading) return <DetailPageSkeleton />;
  if (error) return <ErrorState title="意图详情加载失败" description={error.message || '暂时拿不到详情'} onRetry={() => void mutate()} />;
  if (!intent) return <ErrorState title="意图不存在" description="该意图可能已被删除" />;

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiFetch(`/api/v1/intent?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast.success('意图已删除');
      router.push('/intent');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }

  async function handleSaveWhy() {
    try {
      await apiFetch(`/api/v1/intent/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, description, why: whyDraft, similarSentences }),
      });
      setEditingWhy(false);
      toast.success('why 已更新');
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    }
  }

  async function handleSaveSimilarSentences() {
    try {
      await apiFetch(`/api/v1/intent/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, description, why, similarSentences: similarDraft.split('\n').map((line) => line.trim()).filter(Boolean) }),
      });
      setEditingSimilar(false);
      toast.success('相似句已更新');
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.push('/intent')} aria-label="返回意图库">
          <ArrowLeft className="mr-1 h-4 w-4" />返回意图库
        </Button>
      </div>

      <header className="rounded-[28px] border border-slate-200/80 bg-white px-4 py-5 shadow-sm sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex items-center gap-2">
              <div className="inline-flex h-8 w-8 items-center justify-center rounded-2xl bg-rose-100 text-rose-600">
                <Brain className="h-4 w-4" />
              </div>
              <Badge className={SIGNAL_TYPE_LABELS[signalType]?.color || 'bg-slate-100 text-slate-700'}>
                {SIGNAL_TYPE_LABELS[signalType]?.label || '声明'}
              </Badge>
              {confidence < 0.8 && <Badge variant="outline">低置信度</Badge>}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950">{name}</h1>
            <p className="text-sm leading-6 text-slate-700">{description}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" size="sm" disabled={deleting} onClick={() => setDeleteDialogOpen(true)}>删除</Button>
            <ConfirmDialog
              open={deleteDialogOpen}
              onOpenChange={setDeleteDialogOpen}
              title="确认删除"
              description="此操作将永久删除该意图条目，不可撤销。"
              confirmLabel="确认删除"
              variant="destructive"
              loading={deleting}
              onConfirm={() => void handleDelete()}
            />
          </div>
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-slate-200/80 bg-white shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm text-slate-500"><Hash className="h-4 w-4" />命中次数</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold text-slate-950">{recentHitCount}</p></CardContent>
        </Card>
        <Card className="border-slate-200/80 bg-white shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm text-slate-500"><MessageSquare className="h-4 w-4" />相似句</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold text-slate-950">{similarSentences.length}</p></CardContent>
        </Card>
        <Card className="border-slate-200/80 bg-white shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm text-slate-500"><Clock className="h-4 w-4" />更新时间</CardTitle></CardHeader>
          <CardContent><p className="text-base font-medium text-slate-950">{updatedAt}</p></CardContent>
        </Card>
      </div>

      {sourceSessionId && (
        <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3 text-sm text-slate-600">
          <span className="font-medium">来源对话：</span>
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{sourceSessionId}</code>
          {createdAt && <span className="ml-2 text-slate-400">创建于 {createdAt}</span>}
        </div>
      )}

      <Card className="border-slate-200/80 bg-white shadow-sm">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageSquare className="h-5 w-5 text-amber-600" />why
              </CardTitle>
              <p className="mt-1 text-sm text-slate-500">为什么需要记录这个意图</p>
            </div>
            {!editingWhy && (
              <Button variant="outline" size="sm" onClick={() => { setWhyDraft(why); setEditingWhy(true); }}>编辑</Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {editingWhy ? (
            <div className="space-y-3">
              <Textarea value={whyDraft} onChange={(event) => setWhyDraft(event.target.value)} className="min-h-28" placeholder="说明为什么需要记录这个意图" />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void handleSaveWhy()}>保存</Button>
                <Button variant="outline" size="sm" onClick={() => setEditingWhy(false)}>取消</Button>
              </div>
            </div>
          ) : why.trim() ? (
            <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{why}</p>
          ) : (
            <p className="text-sm text-slate-500">暂无 why</p>
          )}
        </CardContent>
      </Card>

      <Card className="border-slate-200/80 bg-white shadow-sm">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Tag className="h-5 w-5 text-indigo-500" />相似句
              </CardTitle>
              <p className="mt-1 text-sm text-slate-500">用户可能用来表达同一意图的不同说法</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => { setSimilarDraft(similarSentences.join('\n')); setEditingSimilar(true); }}>编辑</Button>
          </div>
        </CardHeader>
        <CardContent>
          {editingSimilar ? (
            <div className="space-y-3">
              <Textarea value={similarDraft} onChange={(event) => setSimilarDraft(event.target.value)} className="min-h-36" placeholder="相似句，每行一条" />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void handleSaveSimilarSentences()}>保存</Button>
                <Button variant="outline" size="sm" onClick={() => setEditingSimilar(false)}>取消</Button>
              </div>
            </div>
          ) : similarSentences.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {similarSentences.map((sentence, i) => (
                <span key={i} className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-sm text-indigo-700">
                  {sentence}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">暂无相似句</p>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-4 text-xs text-slate-400">
        <span>ID: {id}</span>
        {createdAt && <span>创建时间：{createdAt}</span>}
      </div>
    </div>
  );
}
