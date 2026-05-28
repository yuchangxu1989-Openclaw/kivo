import fs from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import { scheduleMaterialProcessing } from '@/lib/wiki-materials';
import { WikiMaterialsStore } from '@/lib/wiki-materials-store';
import { triggerMaterialDispatch } from '@/lib/queue/material-dispatch';
import { triggerInProcessDispatch } from '@/lib/queue/in-process-dispatch';

export const runtime = 'nodejs';
type RetryChannel = 'audio' | 'keyframe';

/**
 * FR-A02 FR-C AC5 - Reprocess a material. Accepts optional `channel` body param
 * to retry only a specific failed channel ('audio' | 'keyframe') for video materials.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> | { id: string } }) {
  const store = new WikiMaterialsStore();
  try {
    const { id } = await context.params;
    const material = store.get(id);
    if (!material) {
      return notFound('材料不存在');
    }

    await fs.access(material.storagePath);

    // Parse optional channel parameter for per-channel retry
    let retryChannel: RetryChannel | undefined;
    try {
      const body = await request.json() as Record<string, unknown>;
      if (body?.channel && typeof body.channel === 'string') {
        const validChannels = ['audio', 'keyframe'];
        if (!validChannels.includes(body.channel)) {
          return badRequest(`无效的通道名：${body.channel}。支持 audio / keyframe。`);
        }
        retryChannel = body.channel as RetryChannel;
      }
    } catch {
      // No body or invalid JSON — full reprocess
    }

    store.markProcessing(material.id);
    scheduleMaterialProcessing(material.id, retryChannel);
    triggerMaterialDispatch(material.id);
    triggerInProcessDispatch();

    return NextResponse.json({
      success: true,
      fileId: material.id,
      status: 'processing' as const,
      retryChannel: retryChannel ?? null,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return notFound('原始文件不存在，无法重新处理');
    }
    return serverError(error instanceof Error ? error.message : 'Unknown error');
  } finally {
    store.close();
  }
}
