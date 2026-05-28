import { NextResponse } from 'next/server';
import { getWikiRepository } from '@/lib/wiki-engine';
import { openWebDb } from '@/lib/db';
import { serverError } from '@/lib/errors';
import { WikiMaterialsStore } from '@/lib/wiki-materials-store';
import type { ApiResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type PipelineStatus = 'pending' | 'slicing' | 'extracting' | 'injecting' | 'done' | 'failed';

interface MaterialListItem {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  status: 'processing' | 'done' | 'failed' | 'skipped';
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

type RawMaterialPipelineStatus =
  | 'pending'
  | 'in_progress'
  | 'classified'
  | 'done'
  | 'failed'
  | null
  | string;

/**
 * 将后端记录的 pipeline_status / status 统一映射到前端可读枚举
 * pending / slicing / extracting / injecting / done / failed（FR-B AC3）。
 */
function normalizePipelineStatus(
  pipelineStatus: RawMaterialPipelineStatus,
  fallbackStatus: string,
): PipelineStatus {
  if (pipelineStatus === 'failed' || fallbackStatus === 'failed') return 'failed';
  if (pipelineStatus === 'done' || fallbackStatus === 'done') return 'done';
  if (pipelineStatus === 'in_progress') return 'extracting';
  if (pipelineStatus === 'classified') return 'injecting';
  return 'pending';
}

function inferAssetKind(mimeType: string, fileName: string): string {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  const ext = fileName.toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (ext === 'docx' || ext === 'doc') return 'docx';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return 'pdf';
}

export async function GET() {
  const store = new WikiMaterialsStore();
  const db = openWebDb(false);
  try {
    const repo = getWikiRepository();
    const subjectRows = db
      .prepare(`SELECT id, name FROM subject_nodes WHERE merged_into IS NULL`)
      .all() as Array<{ id: string; name: string }>;
    const subjectNameById = new Map(subjectRows.map((row) => [row.id, row.name]));
    const items: MaterialListItem[] = store.list().map((material) => {
      const pipelineStatus = normalizePipelineStatus(
        material.pipelineStatus as RawMaterialPipelineStatus,
        material.status,
      );
      const assetKind =
        (material as { assetKind?: string | null }).assetKind ||
        inferAssetKind(material.mimeType, material.fileName);
      return {
        id: material.id,
        fileName: material.fileName,
        mimeType: material.mimeType,
        fileSize: material.fileSize,
        status: material.status,
        pipelineStatus,
        classificationStatus: material.classificationStatus,
        spaceId: material.spaceId,
        wikiPageCount: material.wikiPageCount,
        createdAt: material.createdAt,
        updatedAt: material.updatedAt,
        errorMessage: material.errorMessage,
        assetKind,
        subjectNodeId: (material as { subjectNodeId?: string | null }).subjectNodeId ?? null,
        subjectName: material.subjectNodeId ? subjectNameById.get(material.subjectNodeId) ?? null : null,
        outputPages: material.wikiPageIds
          .map((pageId) => repo.findById(pageId))
          .filter((page): page is NonNullable<typeof page> => Boolean(page))
          .map((page) => ({
            id: page.id,
            title: page.title,
            summary: page.summary,
            updatedAt: page.updatedAt,
          })),
      };
    });

    const response: ApiResponse<MaterialListItem[]> = {
      data: items,
      meta: {
        total: items.length,
        page: 1,
        pageSize: items.length,
      },
    };
    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      },
    });
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Unknown error');
  } finally {
    store.close();
  }
}
