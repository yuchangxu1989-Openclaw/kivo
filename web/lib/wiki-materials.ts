import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WikiCollectionPipeline } from '@kivo/wiki/collection/pipeline.js';
import { writeStagingMaterialsToDb } from '@kivo/wiki/collection/staging-materials.js';
import type { CollectorContext, VideoChannelName, WikiDraft } from '@kivo/wiki/types.js';
import { getWikiRepository } from '@/lib/wiki-engine';
import { openWebDb } from '@/lib/governance-store';
import { getMaterialsStorageRoot, WikiMaterialsStore, type MaterialRecord } from '@/lib/wiki-materials-store';

export const MAX_MATERIAL_FILE_SIZE_BYTES = 400 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'image/jpeg',
  'image/png',
  'video/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
]);

function inferMimeTypeFromName(fileName: string): string | null {
  const ext = fileName.toLowerCase().match(/\.([^.]+)$/)?.[1];
  return ext ? MIME_BY_EXTENSION[ext] ?? null : null;
}

export function detectMaterialMimeType(fileName: string, providedType?: string | null) {
  const provided = (providedType || '').trim();
  const inferred = inferMimeTypeFromName(fileName);
  const mimeType = provided || inferred || 'application/octet-stream';
  const category = categorizeMaterialMimeType(mimeType);
  return {
    mimeType,
    supported: SUPPORTED_MIME_TYPES.has(mimeType) || category !== 'unsupported',
    category,
    routeParams: { category, mimeType, inferredMimeType: inferred, mimeConflict: Boolean(provided && inferred && provided !== inferred) },
  };
}

export function categorizeMaterialMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase().trim();
  if (normalized === 'application/pdf') return 'pdf';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('text/') || normalized === 'application/json') return 'text';
  return 'unsupported';
}

export function buildStoredMaterialPath(materialId: string, fileName: string) {
  const safeName = fileName.replace(/[^\w.\-()\u4e00-\u9fa5]/g, '_');
  return path.join(getMaterialsStorageRoot(), `${materialId}-${safeName}`);
}

async function buildCollectorContext(fileName: string): Promise<CollectorContext> {
  return {
    model: 'default',
    llm: {
      async complete(req) {
        return JSON.stringify({
          title: fileName.replace(/\.[^.]+$/, ''),
          summary: req.content.slice(0, 180),
          tags: [],
          sections: [{ title: '内容', level: 1, content: req.content.slice(0, 5000) }],
          links: [],
          warnings: ['当前上传入口未接入外部 LLM，已生成基础 Wiki 草稿。'],
        });
      },
    },
    timeoutMs: 300_000,
  };
}

function resolveSpaceId(rawSpaceId: string) {
  const repo = getWikiRepository();
  if (!rawSpaceId || rawSpaceId === 'default') {
    const pipeline = new WikiCollectionPipeline(repo, {
      model: 'default',
      llm: { complete: async () => '{}' },
    });
    return pipeline.ensureDefaultSpace().id;
  }
  const existing = repo.findById(rawSpaceId);
  if (!existing || existing.type !== 'wiki_space') {
    throw new Error('目标空间不存在');
  }
  return rawSpaceId;
}

export function ensureMaterialSpaceExists(rawSpaceId: string) {
  return resolveSpaceId(rawSpaceId);
}

function normalizeDraft(draft: WikiDraft, material: MaterialRecord, targetSpaceId: string) {
  draft.suggestedSpaceId = targetSpaceId;
  draft.source = {
    type: 'document',
    uri: `upload://material/${material.id}`,
    fileName: material.fileName,
    mimeType: material.mimeType,
    collectedAt: new Date().toISOString(),
  };
  return draft;
}

export async function processMaterial(materialId: string, retryChannel?: VideoChannelName) {
  const store = new WikiMaterialsStore();
  try {
    const material = store.get(materialId);
    if (!material) {
      throw new Error('材料不存在');
    }

    const buffer = await fs.readFile(material.storagePath);
    const targetSpaceId = resolveSpaceId(material.spaceId);
    const repo = getWikiRepository();
    const context = await buildCollectorContext(material.fileName);
    const pipeline = new WikiCollectionPipeline(repo, context);

    const result = await pipeline.collectFromMultimodal({
      fileName: material.fileName,
      mimeType: material.mimeType,
      content: new Uint8Array(buffer),
      spaceId: targetSpaceId,
      sourceMediaPath: material.storagePath,
      timeoutMs: 300_000,
      retryChannel,
    });

    if (result.category === 'unknown') {
      store.markUnsupported(material.id, result.warnings.join('；') || '不支持的素材类型');
      return;
    }

    // FR-A02 FR-C AC5 - persist per-channel failure details for video materials
    if (result.channelFailures?.length) {
      store.updateRouteParams(material.id, { channelFailures: result.channelFailures });
    }

    await writeStagingMaterials(material, result);

    if (!result.draft) {
      if (result.extractedText.trim()) {
        store.markDone(material.id, []);
        return;
      }
      throw new Error(result.warnings.join('；') || '多模态处理未生成草稿');
    }

    const draft = normalizeDraft(result.draft, material, targetSpaceId);
    const existing = repo.findPageBySourceUri(`upload://material/${material.id}`, targetSpaceId);
    const page = await pipeline.confirmDraft({
      draft,
      parentId: targetSpaceId,
      replacePageId: existing?.id,
    });

    store.markDone(material.id, [page.id]);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    store.markFailed(materialId, message);
  } finally {
    store.close();
  }
}

export function scheduleMaterialProcessing(materialId: string, retryChannel?: VideoChannelName) {
  void processMaterial(materialId, retryChannel);
}

export async function persistUploadedMaterial(input: {
  fileName: string;
  mimeType: string;
  fileSize: number;
  spaceId: string;
  arrayBuffer: ArrayBuffer;
}) {
  const store = new WikiMaterialsStore();
  try {
    const id = randomUUID();
    const storagePath = buildStoredMaterialPath(id, input.fileName);
    await fs.writeFile(storagePath, Buffer.from(input.arrayBuffer));

    const record = store.create({
      id,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      spaceId: input.spaceId,
      storagePath,
      routeCategory: categorizeMaterialMimeType(input.mimeType),
      routeParams: { mimeType: input.mimeType },
    });
    return record;
  } finally {
    store.close();
  }
}
async function writeStagingMaterials(
  material: MaterialRecord,
  result: Parameters<typeof writeStagingMaterialsToDb>[2],
) {
  const db = openWebDb(false);
  try {
    writeStagingMaterialsToDb(db, material, result);
  } finally {
    db.close();
  }
}
