'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  CheckCircle2,
  FileImage,
  FileText,
  Film,
  LoaderCircle,
  MoreHorizontal,
  Music4,
  RefreshCcw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { FileUploader } from '@/components/wiki/file-uploader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import type { ApiResponse } from '@/types';

type MaterialStatus = 'processing' | 'done' | 'failed';

interface MaterialItem {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  status: MaterialStatus;
  spaceId: string;
  wikiPageCount: number;
  createdAt: string;
  updatedAt: string;
  errorMessage: string | null;
  outputPages: Array<{
    id: string;
    title: string;
    summary: string;
    updatedAt: string;
  }>;
}

const STATUS_BADGE: Record<MaterialStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  processing: { label: '处理中', variant: 'outline' },
  done: { label: '已完成', variant: 'default' },
  failed: { label: '失败', variant: 'destructive' },
};

function formatBytes(size: number) {
  if (size >= 1024 * 1024 * 1024) return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function formatTime(iso: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function FileTypeIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith('image/')) return <FileImage className="h-5 w-5" />;
  if (mimeType.startsWith('video/')) return <Film className="h-5 w-5" />;
  if (mimeType.startsWith('audio/')) return <Music4 className="h-5 w-5" />;
  return <FileText className="h-5 w-5" />;
}

export default function WikiMaterialsPage() {
  const [preview, setPreview] = useState<MaterialItem | null>(null);
  const { data, isLoading, error, mutate } = useApi<ApiResponse<MaterialItem[]>>('/api/v1/wiki/materials', {
    refreshInterval(currentData) {
      const items = currentData?.data ?? [];
      return items.some((item) => item.status === 'processing') ? 4000 : 0;
    },
  });

  const materials = data?.data ?? [];
  const stats = useMemo(() => ({
    total: materials.length,
    processing: materials.filter((item) => item.status === 'processing').length,
    done: materials.filter((item) => item.status === 'done').length,
  }), [materials]);

  const removeMaterial = async (materialId: string) => {
    const shouldDelete = window.confirm('确定删除这个文件吗？关联的 Wiki 页面也会被删除。');
    if (!shouldDelete) return;

    try {
      await apiFetch(`/api/v1/wiki/materials/${materialId}`, { method: 'DELETE' });
      toast.success('材料已删除');
      void mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  const reprocessMaterial = async (materialId: string) => {
    try {
      await apiFetch(`/api/v1/wiki/materials/${materialId}/reprocess`, { method: 'POST' });
      toast.success('已重新加入处理队列');
      void mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重新处理失败');
    }
  };

  if (isLoading) return <ListPageSkeleton filters={3} rows={5} />;
  if (error) return <ErrorState title="材料库加载失败" description={error.message} onRetry={() => void mutate()} />;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">材料库</h1>
        <p className="max-w-3xl text-sm leading-6 text-slate-600">
          上传 PDF、图片、视频和音频后，KIVO 会异步解析并生成 Wiki 页面。这里可以查看处理状态、删除材料或重新处理。
        </p>
      </div>

      <FileUploader onUploaded={() => void mutate()} />

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-slate-200 bg-white shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">总材料数</CardTitle>
          </CardHeader>
          <CardContent><p className="text-3xl font-semibold text-slate-950">{stats.total}</p></CardContent>
        </Card>
        <Card className="border-slate-200 bg-white shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">处理中</CardTitle>
          </CardHeader>
          <CardContent><p className="text-3xl font-semibold text-slate-950">{stats.processing}</p></CardContent>
        </Card>
        <Card className="border-slate-200 bg-white shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">已产出 Wiki</CardTitle>
          </CardHeader>
          <CardContent><p className="text-3xl font-semibold text-slate-950">{stats.done}</p></CardContent>
        </Card>
      </div>

      {materials.length === 0 ? (
        <EmptyState
          title="还没有上传材料"
          description="先上传一个文件，KIVO 会自动完成解析、抽取和 Wiki 页面生成。"
        />
      ) : (
        <div className="space-y-3">
          {materials.map((material) => {
            const statusMeta = STATUS_BADGE[material.status];
            return (
              <Card key={material.id} className="border-slate-200 bg-white shadow-sm">
                <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 gap-4">
                    <div className="mt-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
                      <FileTypeIcon mimeType={material.mimeType} />
                    </div>
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-lg font-semibold text-slate-950">{material.fileName}</h2>
                        <Badge variant={statusMeta.variant}>
                          {material.status === 'processing' && <LoaderCircle className="mr-1 h-3.5 w-3.5 animate-spin" />}
                          {material.status === 'done' && <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
                          {material.status === 'failed' && <AlertCircle className="mr-1 h-3.5 w-3.5" />}
                          {statusMeta.label}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
                        <span>大小：{formatBytes(material.fileSize)}</span>
                        <span>上传时间：{formatTime(material.createdAt)}</span>
                        <span>产出页面：{material.wikiPageCount}</span>
                      </div>
                      {material.errorMessage && (
                        <p className="text-sm text-red-600">失败原因：{material.errorMessage}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={() => setPreview(material)} disabled={material.outputPages.length === 0}>
                      查看产出
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="icon" aria-label="更多操作">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => void reprocessMaterial(material.id)}>
                          <RefreshCcw className="mr-2 h-4 w-4" />
                          重新处理
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void removeMaterial(material.id)} className="text-red-600 focus:text-red-600">
                          <Trash2 className="mr-2 h-4 w-4" />
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-3xl bg-white">
          <DialogHeader>
            <DialogTitle>产出的 Wiki 页面</DialogTitle>
            <DialogDescription>
              {preview ? `${preview.fileName} 共生成 ${preview.outputPages.length} 个页面。` : '查看本次上传生成的 Wiki 页面。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {preview?.outputPages.length ? preview.outputPages.map((page) => (
              <div key={page.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-slate-950">{page.title}</h3>
                    <p className="text-sm leading-6 text-slate-600">{page.summary || '暂无摘要'}</p>
                    <p className="text-xs text-slate-500">最近更新：{formatTime(page.updatedAt)}</p>
                  </div>
                  <Button variant="outline" asChild>
                    <Link href="/wiki">去 Wiki 查看</Link>
                  </Button>
                </div>
              </div>
            )) : (
              <EmptyState title="还没有可查看的页面" description="等处理完成后，这里会展示对应的 Wiki 产出。" />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
