import fs from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { notFound, serverError } from '@/lib/errors';
import { scheduleMaterialProcessing } from '@/lib/wiki-materials';
import { WikiMaterialsStore } from '@/lib/wiki-materials-store';

export const runtime = 'nodejs';

export async function POST(_: Request, context: { params: Promise<{ id: string }> | { id: string } }) {
  const store = new WikiMaterialsStore();
  try {
    const { id } = await context.params;
    const material = store.get(id);
    if (!material) {
      return notFound('材料不存在');
    }

    await fs.access(material.storagePath);
    store.markProcessing(material.id);
    scheduleMaterialProcessing(material.id);

    return NextResponse.json({
      success: true,
      fileId: material.id,
      status: 'processing' as const,
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
