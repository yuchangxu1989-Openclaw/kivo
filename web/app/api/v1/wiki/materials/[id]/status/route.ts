import { NextResponse } from 'next/server';
import { notFound, serverError } from '@/lib/errors';
import { getWikiRepository } from '@/lib/wiki-engine';
import { WikiMaterialsStore, type MaterialPipelineStatus } from '@/lib/wiki-materials-store';

type UiPipelineStatus = 'pending' | 'slicing' | 'extracting' | 'injecting' | 'done' | 'failed';

function normalizePipelineStatus(input: MaterialPipelineStatus, fallback: string): UiPipelineStatus {
  if (input === 'failed' || fallback === 'failed') return 'failed';
  if (input === 'done' || fallback === 'done') return 'done';
  if (input === 'in_progress') return 'extracting';
  if (input === 'classified') return 'injecting';
  return 'pending';
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_: Request, context: { params: Promise<{ id: string }> | { id: string } }) {
  const store = new WikiMaterialsStore();
  try {
    const { id } = await context.params;
    const material = store.get(id);
    if (!material) return notFound('材料不存在');

    const repo = getWikiRepository();
    const outputPages = material.wikiPageIds
      .map((pageId) => repo.findById(pageId))
      .filter((page): page is NonNullable<typeof page> => Boolean(page))
      .map((page) => ({
        id: page.id,
        title: page.title,
        href: `/wiki/pages/${page.id}`,
      }));

    return NextResponse.json({
      data: {
        materialId: material.id,
        fileName: material.fileName,
        status: normalizePipelineStatus(material.pipelineStatus, material.status),
        pipelineStatus: material.pipelineStatus,
        classificationStatus: material.classificationStatus,
        knowledgeEntryCount: material.extractCount,
        wikiPageCount: material.wikiPageCount,
        outputPages,
        lastError: material.errorMessage,
        /** FR-A02 FR-C AC5 - per-channel failure details parsed from routeParams */
        channelFailures: material.routeParams?.channelFailures ?? null,
        updatedAt: material.updatedAt,
      },
    });
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Unknown error');
  } finally {
    store.close();
  }
}
