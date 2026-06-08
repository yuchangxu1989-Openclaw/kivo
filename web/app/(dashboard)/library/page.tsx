'use client';

// Disable static generation: page depends on user-scoped runtime data and providers that use useRouter.
export const dynamic = 'force-dynamic';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
  BookOpen,
  FileImage,
  FileText,
  Film,
  FolderInput,
  Loader2,
  Music4,
  FileType2,
  RefreshCcw,
} from 'lucide-react';
import { ImportMaterialButton } from '@/components/material/ImportMaterialButton';
import {
  MaterialCard as SharedMaterialCard,
  type MaterialCardMaterial,
  type MaterialCardStatus,
} from '@/components/material/MaterialCard';
import { Button } from '@/components/ui/button';
import { apiFetch, withBasePath } from '@/lib/client-api';
import { useApi } from '@/hooks/use-api';
import { toast } from 'sonner';
import type { ApiResponse } from '@/types';

type AssetKind = 'pdf' | 'docx' | 'image' | 'audio' | 'video' | 'markdown';

/**
 * /api/v1/wiki/materials 列表项；与 GET /api/v1/wiki/materials route 中的
 * MaterialListItem 保持一致。
 */
interface MaterialListItem {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  status: 'processing' | 'done' | 'failed';
  pipelineStatus: PipelineStatus;
  classificationStatus: string | null;
  spaceId: string;
  wikiPageCount: number;
  createdAt: string;
  updatedAt: string;
  errorMessage: string | null;
  assetKind: string | null;
  subjectNodeId: string | null;
  subjectName: string | null;
  outputPages: Array<{
    id: string;
    title: string;
    summary: string;
    updatedAt: string;
  }>;
}

/**
 * 流水线状态枚举（FR-B AC3）。所有展示文案统一从 PIPELINE_LABELS 取，
 * 禁止把英文 raw 值直接渲染给用户。
 */
type PipelineStatus = 'pending' | 'slicing' | 'extracting' | 'injecting' | 'done' | 'failed';

const PIPELINE_LABELS: Record<PipelineStatus, string> = {
  pending: '已登记，等待处理',
  slicing: '切片中',
  extracting: '抽取知识中',
  injecting: '写入图谱中',
  done: '已完成',
  failed: '处理失败',
};

const PIPELINE_CARD_STATUS: Record<PipelineStatus, MaterialCardStatus> = {
  pending: 'pending',
  slicing: 'in_progress',
  extracting: 'in_progress',
  injecting: 'in_progress',
  done: 'ready',
  failed: 'failed',
};

const ASSET_META: Record<AssetKind, { label: string; icon: React.ComponentType<{ className?: string }>; className: string }> = {
  pdf: { label: 'PDF', icon: FileText, className: 'bg-red-50 text-red-600' },
  docx: { label: 'DOCX', icon: FileType2, className: 'bg-blue-50 text-blue-600' },
  image: { label: 'IMAGE', icon: FileImage, className: 'bg-emerald-50 text-emerald-600' },
  audio: { label: 'AUDIO', icon: Music4, className: 'bg-slate-100 text-slate-700' },
  video: { label: 'VIDEO', icon: Film, className: 'bg-amber-50 text-amber-600' },
  markdown: { label: 'MD', icon: BookOpen, className: 'bg-slate-100 text-slate-700' },
};

function normalizeAssetKind(value: string | null | undefined): AssetKind {
  if (value === 'docx' || value === 'image' || value === 'audio' || value === 'video' || value === 'markdown') return value;
  return 'pdf';
}

function cleanName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return '未命名素材';
  if (/[\u4e00-\u9fa5A-Za-z0-9]/.test(trimmed)) return trimmed;
  return trimmed.replace(/[_-]+/g, ' ').trim() || '未命名素材';
}

interface PendingCard {
  id: string;
  fileName: string;
  submittedAt: string;
  /** 客户端临时缓存的状态（来自 status route 轮询）；未轮询前默认 pending。 */
  pipelineStatus: PipelineStatus;
  errorMessage: string | null;
}

interface MaterialStatusResponse {
  data?: {
    materialId: string;
    status: PipelineStatus;
    pipelineStatus: string | null;
    lastError: string | null;
  };
  error?: { message?: string };
}

/**
 * 单条 pending 卡片的状态轮询 hook。
 *
 * 实装 FR-B AC2：每 3.5 秒调 /api/v1/wiki/materials/{id}/status 一次，
 * 直到状态进入 done 或 failed 后停止；进入终态时由父组件决定是否
 * 把卡片移交给「已分类列表」侧。
 */
function useStatusPolling(
  pendingCards: PendingCard[],
  onUpdate: (id: string, patch: Partial<PendingCard>) => void,
) {
  const timersRef = useRef(new Map<string, ReturnType<typeof setInterval>>());

  useEffect(() => {
    const timers = timersRef.current;

    pendingCards.forEach((card) => {
      if (card.pipelineStatus === 'done' || card.pipelineStatus === 'failed') {
        const existing = timers.get(card.id);
        if (existing) {
          clearInterval(existing);
          timers.delete(card.id);
        }
        return;
      }
      if (timers.has(card.id)) return;

      const tick = async () => {
        try {
          const resp = await fetch(
            withBasePath(`/api/v1/wiki/materials/${card.id}/status`),
            { cache: 'no-store' },
          );
          if (!resp.ok) return;
          const payload = (await resp.json()) as MaterialStatusResponse;
          if (!payload.data) return;
          const next: PipelineStatus = payload.data.status;
          onUpdate(card.id, {
            pipelineStatus: next,
            errorMessage: payload.data.lastError ?? null,
          });
        } catch {
          // 网络错误时下一轮重试，不在 UI 上闪烁错误
        }
      };

      void tick();
      const handle = setInterval(tick, 3500);
      timers.set(card.id, handle);
    });

    // 清理：组件卸载或 pending 列表瘦身时关闭多余的 timer
    return () => {
      const knownIds = new Set(pendingCards.map((card) => card.id));
      for (const [id, handle] of timers) {
        if (!knownIds.has(id)) {
          clearInterval(handle);
          timers.delete(id);
        }
      }
    };
  }, [pendingCards, onUpdate]);

  useEffect(() => {
    return () => {
      const timers = timersRef.current;
      for (const handle of timers.values()) clearInterval(handle);
      timers.clear();
    };
  }, []);
}

interface ProcessingCardProps {
  card: PendingCard;
}

function ProcessingCard({ card }: ProcessingCardProps) {
  const assetKind = normalizeAssetKind(card.fileName.toLowerCase().match(/\.([^.]+)$/)?.[1]);
  const assetMeta = ASSET_META[assetKind];
  const AssetIcon = assetMeta.icon;
  const statusLabel = PIPELINE_LABELS[card.pipelineStatus];
  const cardStatus = PIPELINE_CARD_STATUS[card.pipelineStatus];

  return (
    <div className="space-y-3" data-material-id={card.id} data-asset-kind={assetKind}>
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <div className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl ${assetMeta.className}`} aria-hidden="true">
          <AssetIcon className="h-4 w-4" />
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">{assetMeta.label}</span>
        {card.pipelineStatus !== 'done' && card.pipelineStatus !== 'failed' && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
            <Loader2 className="h-3 w-3 animate-spin" />
            {statusLabel}
          </span>
        )}
      </div>
      <SharedMaterialCard
        material={{
          id: card.id,
          title: cleanName(card.fileName),
          source: assetKind.toUpperCase(),
          subject: card.pipelineStatus === 'failed' ? '处理失败，请稍后重试' : '正在处理，未挂学科',
          status: cardStatus,
          createdAt: card.submittedAt,
        } satisfies MaterialCardMaterial & { createdAt: string }}
      />
      {card.pipelineStatus === 'failed' && card.errorMessage && (
        <p
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          role="alert"
        >
          {card.errorMessage}
        </p>
      )}
    </div>
  );
}

interface ServerMaterialCardProps {
  material: MaterialListItem;
  onDelete: (material: MaterialListItem) => void;
  onReprocess: (material: MaterialListItem) => void;
}

function ServerMaterialCard({ material, onDelete, onReprocess }: ServerMaterialCardProps) {
  const assetKind = normalizeAssetKind(material.assetKind);
  const assetMeta = ASSET_META[assetKind];
  const AssetIcon = assetMeta.icon;
  const cardStatus = PIPELINE_CARD_STATUS[material.pipelineStatus];
  const subjectLabel = material.subjectName ?? (material.pipelineStatus === 'done' ? '已完成' : PIPELINE_LABELS[material.pipelineStatus]);

  return (
    <div className="space-y-3" data-material-id={material.id} data-asset-kind={assetKind}>
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <div className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl ${assetMeta.className}`} aria-hidden="true">
          <AssetIcon className="h-4 w-4" />
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">{assetMeta.label}</span>
      </div>
      <SharedMaterialCard
        material={{
          id: material.id,
          title: cleanName(material.fileName),
          source: assetKind.toUpperCase(),
          subject: subjectLabel,
          status: cardStatus,
          createdAt: material.createdAt,
        } satisfies MaterialCardMaterial & { createdAt: string }}
        onDetail={() => window.location.href = withBasePath(`/library/${material.id}`)}
        onDelete={() => onDelete(material)}
      />
      {material.pipelineStatus === 'failed' && material.errorMessage && (
        <p
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          role="alert"
        >
          {material.errorMessage}
        </p>
      )}
      {material.pipelineStatus === 'failed' && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => onReprocess(material)}>
            <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />重新处理
          </Button>
        </div>
      )}
    </div>
  );
}

export default function LibraryPage() {
  const { data, mutate } = useApi<ApiResponse<MaterialListItem[]>>('/api/v1/wiki/materials');
  const serverMaterials = data?.data ?? [];

  /** 前端临时维护的「刚提交」卡片，FR-B AC1 要求提交瞬间出现在列表顶部。 */
  const [pendingCards, setPendingCards] = useState<PendingCard[]>([]);

  const updatePendingCard = useCallback(
    (id: string, patch: Partial<PendingCard>) => {
      setPendingCards((prev) => {
        const next = prev.map((card) => (card.id === id ? { ...card, ...patch } : card));
        return next;
      });
      // 终态时刷新服务端列表（done 后会被服务端列表覆盖）
      if (patch.pipelineStatus === 'done' || patch.pipelineStatus === 'failed') {
        void mutate();
      }
    },
    [mutate],
  );

  useStatusPolling(pendingCards, updatePendingCard);

  const handleIngested = useCallback(
    (payload: { id: string; fileName: string; submittedAt: string }) => {
      setPendingCards((prev) => {
        if (prev.some((card) => card.id === payload.id)) return prev;
        return [
          {
            id: payload.id,
            fileName: payload.fileName,
            submittedAt: payload.submittedAt,
            pipelineStatus: 'pending',
            errorMessage: null,
          },
          ...prev,
        ];
      });
    },
    [],
  );

  // 服务端列表里已经包含的素材，不再展示重复的临时卡片
  const visiblePending = useMemo(() => {
    const serverIds = new Set(serverMaterials.map((item) => item.id));
    return pendingCards.filter((card) => !serverIds.has(card.id));
  }, [pendingCards, serverMaterials]);

  const totalCount = serverMaterials.length + visiblePending.length;

  const handleDeleteItem = useCallback(async (material: MaterialListItem) => {
    try {
      await apiFetch(`/api/v1/wiki/materials/${material.id}`, { method: 'DELETE' });
      toast.success('素材已删除');
      void mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    }
  }, [mutate]);

  const handleReprocess = useCallback(async (material: MaterialListItem) => {
    try {
      await apiFetch(`/api/v1/wiki/materials/${material.id}/reprocess`, { method: 'POST' });
      toast.success('已重新加入处理队列');
      void mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重新处理失败');
    }
  }, [mutate]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">原始资料库</h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-600">
            提交的素材会先以「已登记，编译中」状态出现在这里，再逐步推进到切片、抽取知识、写入图谱，直到进入「已完成」状态。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200">
            共 {totalCount} 条素材
          </div>
          <ImportMaterialButton onIngested={handleIngested} />
        </div>
      </div>

      {totalCount === 0 ? (
        <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-800">
            <FolderInput className="h-7 w-7" />
          </div>
          <h2 className="text-lg font-semibold text-slate-950">还没有素材，从导入开始</h2>
          <p className="mt-2 text-sm text-slate-500">点下面的按钮上传文件，素材会先登记到资料库，再逐步处理成可用知识。</p>
          <div className="mt-5 inline-flex">
            <ImportMaterialButton onIngested={handleIngested} />
          </div>
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-3" data-material-count={totalCount}>
          {visiblePending.map((card) => (
            <ProcessingCard key={card.id} card={card} />
          ))}
          {serverMaterials.map((material) => (
            <ServerMaterialCard key={material.id} material={material} onDelete={handleDeleteItem} onReprocess={handleReprocess} />
          ))}
        </div>
      )}
    </div>
  );
}
