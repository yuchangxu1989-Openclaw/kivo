'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FileImage,
  FilePenLine,
  FileText,
  Film,
  LoaderCircle,
  MoreHorizontal,
  Music4,
  Pencil,
  RefreshCcw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { FileUploader, type UploadedMaterialPayload } from '@/components/wiki/file-uploader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState, ErrorState, ListPageSkeleton } from '@/components/ui/page-states';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import type { ApiResponse } from '@/types';

type MaterialStatus = 'processing' | 'done' | 'failed' | 'skipped';

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
  classificationStatus: string | null;
  subjectNodeId: string | null;
  subjectName: string | null;
  outputPages: Array<{
    id: string;
    title: string;
    summary: string;
    updatedAt: string;
  }>;
}

interface WikiAnnotation {
  id: string;
  wikiPageId: string;
  content: string;
  position: number | null;
  createdAt: string;
  updatedAt: string;
}

interface WikiPageEditorState {
  id: string;
  title: string;
  summary: string;
  content: string;
  annotations: WikiAnnotation[];
}

const STATUS_BADGE: Record<MaterialStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  processing: { label: '处理中', variant: 'outline' },
  done: { label: '已完成', variant: 'default' },
  failed: { label: '失败', variant: 'destructive' },
  skipped: { label: '已跳过', variant: 'secondary' },
};

const STATUS_FALLBACK: { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } = {
  label: '未知',
  variant: 'outline',
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

function isStuckProcessing(iso: string): boolean {
  const elapsed = Date.now() - new Date(iso).getTime();
  return elapsed > 600000;
}

export default function WikiMaterialsPage() {
  const [preview, setPreview] = useState<MaterialItem | null>(null);
  const [optimistic, setOptimistic] = useState<MaterialItem[]>([]);
  const [editingPage, setEditingPage] = useState<WikiPageEditorState | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [newAnnotation, setNewAnnotation] = useState('');
  const [savingAnnotation, setSavingAnnotation] = useState(false);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingAnnotationContent, setEditingAnnotationContent] = useState('');
  const { data, isLoading, error, mutate } = useApi<ApiResponse<MaterialItem[]>>('/api/v1/wiki/materials', {
    refreshInterval(currentData) {
      const items = currentData?.data ?? [];
      return items.some((item) => item.status === 'processing') ? 4000 : 0;
    },
  });

  const serverMaterials = data?.data ?? [];
  const materials = useMemo(() => {
    const seen = new Set(serverMaterials.map((item) => item.id));
    const pending = optimistic.filter((item) => !seen.has(item.id));
    return [...pending, ...serverMaterials];
  }, [serverMaterials, optimistic]);

  useEffect(() => {
    if (optimistic.length === 0) return;
    const seen = new Set(serverMaterials.map((item) => item.id));
    const remaining = optimistic.filter((item) => !seen.has(item.id));
    if (remaining.length !== optimistic.length) setOptimistic(remaining);
  }, [serverMaterials, optimistic]);

  const handleUploaded = (uploaded?: UploadedMaterialPayload & { mimeType: string; spaceId: string }) => {
    if (uploaded) {
      const placeholder: MaterialItem = {
        id: uploaded.fileId,
        fileName: uploaded.fileName,
        mimeType: uploaded.mimeType,
        fileSize: uploaded.fileSize,
        status: uploaded.status,
        spaceId: uploaded.spaceId,
        wikiPageCount: 0,
        createdAt: uploaded.createdAt,
        updatedAt: uploaded.createdAt,
        errorMessage: null,
        classificationStatus: null,
        subjectNodeId: null,
        subjectName: null,
        outputPages: [],
      };
      setOptimistic((prev) => [placeholder, ...prev.filter((item) => item.id !== placeholder.id)]);
    }
    void mutate();
  };

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
      setOptimistic((prev) => prev.filter((item) => item.id !== materialId));
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

  const openPageEditor = async (pageId: string) => {
    setEditorOpen(true);
    setEditorLoading(true);
    setEditingPage(null);
    setEditingAnnotationId(null);
    setEditingAnnotationContent('');
    setNewAnnotation('');
    try {
      const response = await apiFetch<{ data: WikiPageEditorState }>(`/api/v1/wiki/${pageId}`);
      setEditingPage(response.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载材料详情失败');
      setEditorOpen(false);
    } finally {
      setEditorLoading(false);
    }
  };

  const savePageContent = async () => {
    if (!editingPage) return;
    setEditorSaving(true);
    try {
      const response = await apiFetch<{ data: WikiPageEditorState; meta?: { reextractTriggered?: boolean } }>(
        `/api/v1/wiki/${editingPage.id}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            title: editingPage.title,
            summary: editingPage.summary,
            content: editingPage.content,
          }),
        },
      );
      setEditingPage(response.data);
      toast.success(response.meta?.reextractTriggered ? '材料已保存，正在重新提取知识点' : '材料已保存');
      void mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setEditorSaving(false);
    }
  };

  const createAnnotation = async () => {
    if (!editingPage) return;
    const content = newAnnotation.trim();
    if (!content) return;

    setSavingAnnotation(true);
    try {
      const response = await apiFetch<{ data: WikiAnnotation }>(`/api/v1/wiki/${editingPage.id}/annotations`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
      setEditingPage({
        ...editingPage,
        annotations: [response.data, ...editingPage.annotations],
      });
      setNewAnnotation('');
      toast.success('批注已添加');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加批注失败');
    } finally {
      setSavingAnnotation(false);
    }
  };

  const saveAnnotation = async (annotationId: string) => {
    if (!editingPage) return;
    const content = editingAnnotationContent.trim();
    if (!content) return;

    try {
      const response = await apiFetch<{ data: WikiAnnotation }>(`/api/v1/wiki/${editingPage.id}/annotations/${annotationId}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      });
      setEditingPage({
        ...editingPage,
        annotations: editingPage.annotations.map((annotation) =>
          annotation.id === annotationId ? response.data : annotation,
        ),
      });
      setEditingAnnotationId(null);
      setEditingAnnotationContent('');
      toast.success('批注已更新');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新批注失败');
    }
  };

  const removeAnnotation = async (annotationId: string) => {
    if (!editingPage) return;
    try {
      await apiFetch(`/api/v1/wiki/${editingPage.id}/annotations/${annotationId}`, {
        method: 'DELETE',
      });
      setEditingPage({
        ...editingPage,
        annotations: editingPage.annotations.filter((annotation) => annotation.id !== annotationId),
      });
      toast.success('批注已删除');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除批注失败');
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

      <FileUploader onUploaded={handleUploaded} />

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
            const statusMeta = STATUS_BADGE[material.status] ?? STATUS_FALLBACK;
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
                          {material.status === 'skipped' && <AlertTriangle className="mr-1 h-3.5 w-3.5" />}
                          {statusMeta.label}
                        </Badge>
                        {material.status === 'processing' && isStuckProcessing(material.updatedAt) && (
                          <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                            <AlertTriangle className="h-3 w-3" />处理时间较长，请稍候
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
                        <span>大小：{formatBytes(material.fileSize)}</span>
                        <span>上传时间：{formatTime(material.createdAt)}</span>
                        <span>产出页面：{material.wikiPageCount}</span>
                        {material.subjectName && <span>当前归类：{material.subjectName}</span>}
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
                    <Link href={`/wiki?space=${preview.spaceId}&page=${page.id}`}>去 Wiki 查看</Link>
                  </Button>
                  <Button variant="outline" onClick={() => void openPageEditor(page.id)}>
                    <FilePenLine className="mr-2 h-4 w-4" />
                    编辑
                  </Button>
                </div>
              </div>
            )) : (
              <EmptyState title="还没有可查看的页面" description="等处理完成后，这里会展示对应的 Wiki 产出。" />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open);
          if (!open) {
            setEditingPage(null);
            setEditingAnnotationId(null);
            setEditingAnnotationContent('');
            setNewAnnotation('');
          }
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto bg-white">
          <DialogHeader>
            <DialogTitle>编辑 Wiki 材料</DialogTitle>
            <DialogDescription>保存正文后会重新提取知识点。批注只保存你的手动标注，不会触发重新提取。</DialogDescription>
          </DialogHeader>

          {editorLoading || !editingPage ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
              正在加载材料内容…
            </div>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-950">标题</label>
                  <Textarea
                    value={editingPage.title}
                    onChange={(event) => setEditingPage({ ...editingPage, title: event.target.value })}
                    className="min-h-16 bg-white text-slate-950"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-950">摘要</label>
                  <Textarea
                    value={editingPage.summary}
                    onChange={(event) => setEditingPage({ ...editingPage, summary: event.target.value })}
                    className="min-h-24 bg-white text-slate-950"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-950">正文</label>
                  <Textarea
                    value={editingPage.content}
                    onChange={(event) => setEditingPage({ ...editingPage, content: event.target.value })}
                    className="min-h-[24rem] bg-white font-mono text-sm text-slate-950"
                  />
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={editorSaving}>
                    关闭
                  </Button>
                  <Button onClick={() => void savePageContent()} disabled={editorSaving}>
                    {editorSaving ? '保存中…' : '保存材料'}
                  </Button>
                </DialogFooter>
              </div>

              <aside className="space-y-4 rounded-3xl border border-slate-200 bg-slate-50 p-4">
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-slate-950">批注</h3>
                  <p className="text-xs leading-6 text-slate-600">在这里记录重点、疑问和个人提醒。</p>
                </div>

                <div className="space-y-2">
                  <Textarea
                    value={newAnnotation}
                    onChange={(event) => setNewAnnotation(event.target.value)}
                    placeholder="添加一条批注"
                    className="min-h-24 bg-white text-slate-950"
                  />
                  <Button className="w-full" onClick={() => void createAnnotation()} disabled={savingAnnotation}>
                    {savingAnnotation ? '添加中…' : '添加批注'}
                  </Button>
                </div>

                <div className="space-y-3">
                  {editingPage.annotations.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-5 text-sm text-slate-500">
                      还没有批注。
                    </div>
                  ) : editingPage.annotations.map((annotation) => {
                    const isEditing = editingAnnotationId === annotation.id;
                    return (
                      <div key={annotation.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                        {isEditing ? (
                          <div className="space-y-2">
                            <Textarea
                              value={editingAnnotationContent}
                              onChange={(event) => setEditingAnnotationContent(event.target.value)}
                              className="min-h-24 bg-white text-slate-950"
                            />
                            <div className="flex gap-2">
                              <Button size="sm" onClick={() => void saveAnnotation(annotation.id)}>
                                保存
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setEditingAnnotationId(null);
                                  setEditingAnnotationContent('');
                                }}
                              >
                                取消
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <p className="text-sm leading-6 text-slate-800">{annotation.content}</p>
                            <p className="mt-2 text-xs text-slate-500">更新于 {formatTime(annotation.updatedAt)}</p>
                            <div className="mt-3 flex gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setEditingAnnotationId(annotation.id);
                                  setEditingAnnotationContent(annotation.content);
                                }}
                              >
                                <Pencil className="mr-2 h-3.5 w-3.5" />
                                编辑
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => void removeAnnotation(annotation.id)}>
                                删除
                              </Button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </aside>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
