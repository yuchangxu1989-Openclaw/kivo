import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WikiCollectionPipeline } from '@kivo/wiki/collection/pipeline.js';
import { writeStagingMaterialsToDb } from '@kivo/wiki/collection/staging-materials.js';
import type { CollectorContext, LLMRequest, VideoChannelName, WikiDraft } from '@kivo/wiki/types.js';
import { getWikiRepository } from '@/lib/wiki-engine';
import { openWebDb } from '@/lib/governance-store';
import { chatComplete, LlmClientError } from '@/lib/llm/penguin-client';
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

const UPLOAD_LLM_MODEL =
  process.env.KIVO_UPLOAD_LLM_MODEL ||
  process.env.KIVO_LLM_MODEL ||
  'gpt-5.5';

/**
 * Real LLM adapter for the upload pipeline.
 *
 * Honors two distinct call shapes that the multimodal router uses:
 *   - Text drafting: `content` is a string of extracted text.
 *   - OCR (vision): `content` is a `data:image/<mime>;base64,...` URI; we route it
 *     through the OpenAI-compatible `image_url` content block.
 *
 * Falls back to a deterministic minimal draft when the LLM call fails so a
 * single transient LLM error never bricks an entire upload.
 */
async function buildCollectorContext(fileName: string): Promise<CollectorContext> {
  const fallbackDraft = (excerpt: string) =>
    JSON.stringify({
      title: fileName.replace(/\.[^.]+$/, ''),
      summary: excerpt.slice(0, 180),
      tags: [],
      sections: [{ title: '内容', level: 1, content: excerpt.slice(0, 5000) }],
      links: [],
      warnings: ['LLM call failed for upload context; degraded to extracted text only.'],
    });

  return {
    model: UPLOAD_LLM_MODEL,
    llm: {
      async complete(req: LLMRequest) {
        const isDataUri = typeof req.content === 'string' && req.content.startsWith('data:');
        try {
          if (isDataUri) {
            const url = `${(await import('@/lib/llm/penguin-client')).getPenguinProvider().baseUrl}/v1/chat/completions`;
            const provider = (await import('@/lib/llm/penguin-client')).getPenguinProvider();
            const controller = new AbortController();
            const onAbort = () => controller.abort();
            req.signal?.addEventListener('abort', onAbort, { once: true });
            const timer = setTimeout(() => controller.abort(), 60_000);
            try {
              const response = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${provider.apiKey}`,
                },
                body: JSON.stringify({
                  model: req.model || UPLOAD_LLM_MODEL,
                  temperature: 0,
                  max_tokens: 4000,
                  messages: [{
                    role: 'user',
                    content: [
                      { type: 'text', text: req.prompt },
                      { type: 'image_url', image_url: { url: req.content } },
                    ],
                  }],
                }),
                signal: controller.signal,
              });
              if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new LlmClientError(
                  'HTTP_ERROR',
                  `Vision LLM HTTP ${response.status}: ${body.slice(0, 200)}`,
                  response.status,
                  body,
                );
              }
              const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
              const text = json.choices?.[0]?.message?.content;
              if (typeof text !== 'string') throw new LlmClientError('EMPTY_CONTENT', 'Vision LLM returned empty content');
              return text;
            } finally {
              clearTimeout(timer);
              req.signal?.removeEventListener('abort', onAbort);
            }
          }
          const raw = await chatComplete(
            [
              { role: 'system', content: req.prompt },
              { role: 'user', content: req.content },
            ],
            { model: req.model || UPLOAD_LLM_MODEL, timeoutMs: 60_000, temperature: 0.1 },
          );
          return raw.content;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (isDataUri) throw new Error(`Vision LLM failed: ${reason}`);
          return fallbackDraft(req.content);
        }
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

    // OCR / channel intentionally unavailable: mark skipped (诚实空状态), not failed.
    // After wiring a real vision LLM into buildCollectorContext, the LlmOcrAdapter
    // path can succeed — so skipping is now reserved for the case where both
    // paddleocr and vision LLM legitimately failed for this image.
    {
      const failureReason =
        (result.metadata as { failureReason?: string } | undefined)?.failureReason;
      const isImageWithoutOcr =
        result.category === 'image' &&
        !result.extractedText.trim() &&
        failureReason === 'ocr_engine_unavailable';
      if (isImageWithoutOcr) {
        store.markSkipped(
          material.id,
          `OCR engine unavailable for this image (paddleocr + vision LLM both failed). Warnings: ${result.warnings.join('；') || 'n/a'}`,
        );
        return;
      }
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
