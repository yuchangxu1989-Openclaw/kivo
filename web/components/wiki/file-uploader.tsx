'use client';

import { useId, useRef, useState } from 'react';
import { CloudUpload, FileImage, FileText, Film, Music4 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/wiki/progress-bar';
import { withBasePath } from '@/lib/client-api';

const ACCEPT_ATTR = '.pdf,.jpg,.jpeg,.png,.mp4,.mp3,.wav';
const MAX_FILE_SIZE_BYTES = 400 * 1024 * 1024;
const SUPPORTED_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'video/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
]);

function inferFileType(file: File) {
  const ext = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'wav') return 'audio/wav';
  return file.type;
}

function validateFile(file: File) {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return '文件大小不能超过 400MB';
  }
  const mimeType = inferFileType(file);
  if (!SUPPORTED_TYPES.has(mimeType)) {
    return '仅支持 PDF、JPG/PNG、MP4、MP3/WAV';
  }
  return null;
}

export function FileUploader({
  onUploaded,
  defaultSpaceId = 'default',
}: {
  onUploaded?: () => void;
  defaultSpaceId?: string;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);

  const uploadFile = async (file: File) => {
    const validationError = validateFile(file);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setUploading(true);
    setProgress(0);
    setFileName(file.name);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('spaceId', defaultSpaceId);

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', withBasePath('/api/v1/wiki/upload'));
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable) return;
          setProgress(Math.round((event.loaded / event.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
            return;
          }
          try {
            const payload = JSON.parse(xhr.responseText) as { error?: { message?: string } };
            reject(new Error(payload.error?.message || `上传失败: ${xhr.status}`));
          } catch {
            reject(new Error(`上传失败: ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('网络异常，上传失败'));
        xhr.send(formData);
      });

      setProgress(100);
      toast.success('文件已上传，后台正在处理');
      onUploaded?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上传失败');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div
      className={`rounded-3xl border border-dashed px-6 py-8 transition-colors ${dragging ? 'border-slate-900 bg-slate-50' : 'border-slate-300 bg-white'}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void uploadFile(file);
      }}
    >
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-3">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
            <CloudUpload className="h-6 w-6" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-slate-950">上传文件</h2>
            <p className="text-sm leading-6 text-slate-600">
              支持拖拽上传，也支持手动选择文件。上传后会自动进入多模态 Wiki 处理队列。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1"><FileText className="h-3.5 w-3.5" />PDF</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1"><FileImage className="h-3.5 w-3.5" />JPG / PNG</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1"><Film className="h-3.5 w-3.5" />MP4</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1"><Music4 className="h-3.5 w-3.5" />MP3 / WAV</span>
          </div>
        </div>

        <div className="flex flex-col gap-3 lg:items-end">
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={ACCEPT_ATTR}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadFile(file);
            }}
          />
          <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? '上传中…' : '上传文件'}
          </Button>
          <p className="text-xs text-slate-500">单文件最大 400MB</p>
        </div>
      </div>

      {uploading && (
        <div className="mt-6 space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-3 text-sm text-slate-700">
            <span className="truncate">{fileName}</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} />
        </div>
      )}
    </div>
  );
}
