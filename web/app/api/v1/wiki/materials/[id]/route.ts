import fs from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { getWikiRepository } from '@/lib/wiki-engine';
import { notFound, serverError } from '@/lib/errors';
import { WikiMaterialsStore } from '@/lib/wiki-materials-store';

export const runtime = 'nodejs';

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> | { id: string } }) {
  const store = new WikiMaterialsStore();
  try {
    const { id } = await context.params;
    const material = store.get(id);
    if (!material) {
      return notFound('材料不存在');
    }

    const repo = getWikiRepository();
    for (const pageId of material.wikiPageIds) {
      const page = repo.findById(pageId);
      if (page) repo.softDeleteNode(page.id);
    }

    store.remove(material.id);
    await fs.rm(material.storagePath, { force: true });

    return NextResponse.json({ success: true });
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Unknown error');
  } finally {
    store.close();
  }
}
