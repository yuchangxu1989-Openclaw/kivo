'use client';

/**
 * ImportMaterialButton — 原始资料库的「导入素材」入口
 *
 * 关联 FR：
 *  - FR-W08（文档导入）：Web 端的文档上传与导入入口
 *  - FR-A02（文档知识提取）/ FR-A04 AC2（文件导入）：导入流水线触发点
 *  - 后端 API：POST /api/v1/wiki/upload（FR-W08），返回 fileId 与 初始状态。
 *
 * 边界：
 *  - 仅作为「上传/链接 → 调 wiki 上传接口」的最小可用入口
 *  - 不实现切片/分类/抽取（这些归 A2 与文档导入页 /knowledge/import）
 *  - 提交成功后即刻 toast、关闭弹窗，资料库顶部出现新卡片以 pending 状态轮询
 *  - UI 严格白底黑字，浅色主题
 *
 * FR-B AC5：严禁调废弃素材登记接口，统一走 /api/v1/wiki/upload。
 */

import { useCallback, useRef, useState } from 'react';
import { FolderInput, Loader2, Upload, Link as LinkIcon, FileText, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { withBasePath } from '@/lib/client-api';

type ImportMode = 'file' | 'url';

/** /api/v1/wiki/upload 返回体（FR-W08），与旧版素材登记接口不同。 */
type WikiUploadResponse = {
  success: boolean;
  fileId: string;
  status: 'processing';
};

const ACCEPTED_EXTENSIONS = [
  '.pdf',
  '.png', '.jpg', '.jpeg',
  '.mp3', '.wav',
  '.mp4',
];
const MAX_FILE_SIZE_MB = 400;

type Props = {
  variant?: 'default' | 'outline';
  size?: 'default' | 'sm' | 'lg';
  className?: string;
  label?: string;
  /**
   * 提交成功以后的上报回调。父级（library 页）拿到后立即插入
   * 一张临时卡片（FR-B AC1）并启动轮询（FR-B AC2）。
   */
  onIngested?: (payload: { id: string; fileName: string; submittedAt: string }) => void;
};

export function ImportMaterialButton({
  variant = 'default',
  size = 'default',
  className,
  label = '导入素材',
  onIngested,
}: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ImportMode>('file');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sourceRef, setSourceRef] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reset = useCallback(() => {
    setMode('file');
    setSubmitting(false);
    setError(null);
    setFile(null);
    setSourceRef('');
    setTitle('');
    setTags('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (submitting) return;
      setOpen(next);
      if (!next) reset();
    },
    [reset, submitting],
  );

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const target = event.target.files?.[0];
    setError(null);
    if (!target) {
      setFile(null);
      return;
    }
    const sizeMb = target.size / (1024 * 1024);
    if (sizeMb > MAX_FILE_SIZE_MB) {
      setError(`文件过大：${sizeMb.toFixed(1)} MB，超过 ${MAX_FILE_SIZE_MB} MB 上限`);
      setFile(null);
      return;
    }
    setFile(target);
    if (!title.trim()) {
      const stem = target.name.replace(/\.[^.]+$/, '');
      setTitle(stem);
    }
  }, [title]);

  const submit = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      // FR-B AC5：统一走 /api/v1/wiki/upload（旧素材登记接口已废弃）。
      // 该接口只接 multipart/form-data，同时接受 file + spaceId 字段。
      if (mode === 'url') {
        setError('暂不支持“粘贴链接”入口；wiki 上传接口只受理本地文件。');
        setSubmitting(false);
        return;
      }
      if (!file) {
        setError('请先选择要上传的文件');
        setSubmitting(false);
        return;
      }
      const form = new FormData();
      form.append('file', file);
      form.append('spaceId', 'default');

      const response = await fetch(withBasePath('/api/v1/wiki/upload'), {
        method: 'POST',
        body: form,
      });
      const payload = (await response.json().catch(() => null)) as WikiUploadResponse | { error?: { message?: string } } | null;
      if (!response.ok) {
        const message =
          (payload && typeof payload === 'object' && 'error' in payload &&
            (payload as { error?: { message?: string } }).error?.message) ||
          `上传失败（HTTP ${response.status}）`;
        setError(message);
        setSubmitting(false);
        return;
      }

      const ok = payload as WikiUploadResponse;
      const submittedAt = new Date().toISOString();
      const displayTitle = title.trim() || file.name;

      // FR-B AC1：提交瞬间丢 toast 与新卡片，并关闭弹窗。
      toast.success('已登记，编译中', {
        description: displayTitle,
        duration: 4000,
      });
      onIngested?.({ id: ok.fileId, fileName: displayTitle, submittedAt });
      setOpen(false);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : '网络错误，导入未完成');
      setSubmitting(false);
    }
  }, [file, mode, onIngested, reset, title]);

  // tags / sourceRef 在新接口下不进入请求体（wiki 上传接口仅接收 file/spaceId）；
  // 保留表单供后续套接「创建后补充元数据」的扩展点。
  void tags;
  void sourceRef;

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
        data-testid="library-import-material-button"
      >
        <FolderInput className="mr-2 h-4 w-4" aria-hidden="true" />
        {label}
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="max-w-xl bg-white text-slate-900"
          data-testid="import-material-dialog"
        >
          <DialogHeader>
            <DialogTitle className="text-slate-900">导入素材</DialogTitle>
            <DialogDescription className="text-slate-600">
              上传本地文件，或粘贴一条链接 / 引用，把素材登记进原始资料库；登记后会出现在「文档导入」页继续提取知识。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
              <div className="flex gap-2 rounded-lg bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => { setMode('file'); setError(null); }}
                  className={`flex-1 inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    mode === 'file'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  上传文件
                </button>
                <button
                  type="button"
                  onClick={() => { setMode('url'); setError(null); }}
                  className={`flex-1 inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    mode === 'url'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <LinkIcon className="h-4 w-4" aria-hidden="true" />
                  粘贴链接
                </button>
              </div>

              {mode === 'file' ? (
                <div className="space-y-2">
                  <label htmlFor="import-material-file" className="block text-sm font-medium text-slate-700">
                    选择文件
                  </label>
                  <div className="rounded-lg border border-dashed border-slate-300 bg-white p-4">
                    <input
                      ref={fileInputRef}
                      id="import-material-file"
                      type="file"
                      accept={ACCEPTED_EXTENSIONS.join(',')}
                      onChange={handleFileSelect}
                      className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
                      data-testid="import-material-file-input"
                    />
                    {file && (
                      <div className="mt-3 flex items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">
                        <FileText className="h-4 w-4 text-slate-500" aria-hidden="true" />
                        <span className="flex-1">{file.name}</span>
                        <span className="text-slate-500">{(file.size / (1024 * 1024)).toFixed(2)} MB</span>
                        <button
                          type="button"
                          onClick={() => {
                            setFile(null);
                            if (fileInputRef.current) fileInputRef.current.value = '';
                          }}
                          className="text-slate-400 hover:text-slate-700"
                          aria-label="清除已选文件"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">
                    支持 PDF / JPG / PNG / MP3 / WAV / MP4；单文件上限 {MAX_FILE_SIZE_MB} MB。
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <label htmlFor="import-material-url" className="block text-sm font-medium text-slate-700">
                    素材链接或引用
                  </label>
                  <Input
                    id="import-material-url"
                    value={sourceRef}
                    onChange={(event) => setSourceRef(event.target.value)}
                    placeholder="例如 https://example.com/article 或 file://… / s3://…"
                    data-testid="import-material-url-input"
                  />
                  <p className="text-xs text-slate-500">
                    粘贴一条可定位素材的引用，系统会先登记，等后续切片与知识提取再处理具体内容。
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <label htmlFor="import-material-title" className="block text-sm font-medium text-slate-700">
                  标题（可选）
                </label>
                <Input
                  id="import-material-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="留空则用文件名 / 链接作为标题"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="import-material-tags" className="block text-sm font-medium text-slate-700">
                  标签（可选，英文逗号分隔）
                </label>
                <Textarea
                  id="import-material-tags"
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="多个标签用英文逗号分隔，例如：核心概念, 章节名"
                  className="min-h-[64px]"
                />
              </div>

              {error && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                  data-testid="import-material-error"
                >
                  {error}
                </div>
              )}

              <DialogFooter>
                <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
                  取消
                </Button>
                <Button
                  onClick={() => void submit()}
                  disabled={submitting || (mode === 'file' ? !file : sourceRef.trim().length === 0)}
                  data-testid="import-material-submit"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      正在导入…
                    </>
                  ) : (
                    '提交导入'
                  )}
                </Button>
              </DialogFooter>
            </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
