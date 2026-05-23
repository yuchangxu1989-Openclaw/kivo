import { NextResponse } from 'next/server';
import { getWikiRepository } from '@/lib/wiki-engine';
import { serverError } from '@/lib/errors';
import { WikiMaterialsStore } from '@/lib/wiki-materials-store';
import type { ApiResponse } from '@/types';

export const runtime = 'nodejs';

interface MaterialListItem {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  status: 'processing' | 'done' | 'failed';
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

export async function GET() {
  const store = new WikiMaterialsStore();
  try {
    const repo = getWikiRepository();
    const items: MaterialListItem[] = store.list().map((material) => ({
      id: material.id,
      fileName: material.fileName,
      mimeType: material.mimeType,
      fileSize: material.fileSize,
      status: material.status,
      spaceId: material.spaceId,
      wikiPageCount: material.wikiPageCount,
      createdAt: material.createdAt,
      updatedAt: material.updatedAt,
      errorMessage: material.errorMessage,
      outputPages: material.wikiPageIds
        .map((pageId) => repo.findById(pageId))
        .filter((page): page is NonNullable<typeof page> => Boolean(page))
        .map((page) => ({
          id: page.id,
          title: page.title,
          summary: page.summary,
          updatedAt: page.updatedAt,
        })),
    }));

    const response: ApiResponse<MaterialListItem[]> = {
      data: items,
      meta: {
        total: items.length,
        page: 1,
        pageSize: items.length,
      },
    };
    return NextResponse.json(response);
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Unknown error');
  } finally {
    store.close();
  }
}
