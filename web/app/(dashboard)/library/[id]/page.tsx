'use client';

import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  FileText,
  FileImage,
  Film,
  Music4,
  BookOpen,
  FileType2,
  Trash2,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DetailPageSkeleton, ErrorState } from '@/components/ui/page-states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/client-api';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from 'sonner';
import type { ApiResponse } from '@/types';
import { useState } from 'react';

interface MaterialDetail {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  status: string;
  pipelineStatus: string | null;
  assetKind: string | null;
  subjectNodeId: string | null;
  subjectName: string | null;
  wikiPageCount: number;
  wikiPages: Array<{ id: string; title: string; summary: string; content: string }>;
  entries: Array<{ id: string; title: string; content: string; type: string; summary: string; created_at: string }>;
  sliceCount: number;
  extractCount: number;
  injectCount: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  fact: '事实',
  methodology: '方法论',
  decision: '决策',
  experience: '经验',
  intent: '意图',
  meta: '元知识',
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ASSET_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  pdf: FileText,
  image: FileImage,
  video: Film,
  audio: Music4,
  markdown: BookOpen,
  docx: FileType2,
};

const STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  processing: '处理中',
  done: '已完成',
  failed: '失败',
};

export default function LibraryDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;
  const { data, isLoading, error, mutate } = useApi<ApiResponse<MaterialDetail>>(`/api/v1/materials/${id}`);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  if (isLoading) return <DetailPageSkeleton />;
  if (error) return <ErrorState title="材料详情加载失败" description={error.message || '暂时拿不到详情'} onRetry={() => void mutate()} />;
  if (!data?.data) return <ErrorState title="材料不存在" description="该材料可能已被删除" />;

  const material = data.data;
  const AssetIcon = ASSET_ICONS[material.assetKind ?? 'pdf'] || FileText;

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiFetch(`/api/v1/wiki/materials/${id}`, { method: 'DELETE' });
      toast.success('材料已删除');
      router.push('/library');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.push('/library')} aria-label="返回材料库">
          <ArrowLeft className="mr-1 h-4 w-4" />返回材料库
        </Button>
      </div>

      <header className="rounded-[28px] border border-slate-200/80 bg-white px-4 py-5 shadow-sm sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <div className="inline-flex h-8 w-8 items-center justify-center rounded-2xl bg-slate-100">
                <AssetIcon className="h-4 w-4" />
              </div>
              <Badge variant="outline">{material.mimeType}</Badge>
              <span>{formatFileSize(material.fileSize)}</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950">{material.fileName}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={material.status === 'done' ? 'secondary' : material.status === 'failed' ? 'destructive' : 'outline'}>
                {STATUS_LABELS[material.status] || material.status}
              </Badge>
              {material.subjectName && (
                <Badge variant="outline">{material.subjectName}</Badge>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" size="sm" disabled={deleting} onClick={() => setDeleteDialogOpen(true)}>
              {deleting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
              删除材料
            </Button>
            <ConfirmDialog
              open={deleteDialogOpen}
              onOpenChange={setDeleteDialogOpen}
              title="确认删除"
              description="此操作将删除该材料及其产出的所有知识条目和 Wiki 页面。此操作不可撤销。"
              confirmLabel="确认删除"
              variant="destructive"
              loading={deleting}
              onConfirm={() => void handleDelete()}
            />
          </div>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="border-slate-200/80 bg-white shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-500">切片数</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold text-slate-950">{material.sliceCount}</p></CardContent>
        </Card>
        <Card className="border-slate-200/80 bg-white shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-500">抽取知识</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold text-slate-950">{material.extractCount}</p></CardContent>
        </Card>
        <Card className="border-slate-200/80 bg-white shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-500">Wiki 页面</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold text-slate-950">{material.wikiPageCount}</p></CardContent>
        </Card>
      </div>

      {material.wikiPages.length > 0 && (
        <Card className="border-slate-200/80 bg-white shadow-sm">
          <CardHeader><CardTitle className="text-xl">产出 Wiki 页面</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {material.wikiPages.map((page) => (
              <Link key={page.id} href={`/wiki/${page.id}`} className="block rounded-xl border border-slate-100 bg-slate-50/60 p-4 transition-colors hover:border-slate-200 hover:bg-slate-50">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium text-slate-950">{page.title}</h3>
                  <ExternalLink className="h-4 w-4 text-slate-400" />
                </div>
                {page.summary && <p className="mt-1 text-sm text-slate-600 line-clamp-2">{page.summary}</p>}
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      {material.entries.length > 0 && (
        <Card className="border-slate-200/80 bg-white shadow-sm">
          <CardHeader><CardTitle className="text-xl">知识条目</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {material.entries.map((entry) => (
              <Link key={entry.id} href={`/knowledge/${entry.id}`} className="block rounded-xl border border-slate-100 p-4 transition-colors hover:border-slate-200">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium text-slate-950">{entry.title || '(无标题)'}</h3>
                  <Badge variant="outline" className="shrink-0">{TYPE_LABELS[entry.type] || entry.type}</Badge>
                </div>
                <p className="mt-1 text-sm text-slate-600 line-clamp-2">{entry.summary || entry.content}</p>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      {material.errorMessage && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{material.errorMessage}</div>
      )}
    </div>
  );
}
