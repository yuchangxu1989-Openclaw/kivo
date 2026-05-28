/**
 * FR-1 AC-1.2, NFR-1
 * FR-A02 FR-D
 * Multimodal router: decide one stable upload route, persist route metadata,
 * and dispatch content to the appropriate parser based on MIME-first routing.
 */

import { randomUUID } from 'node:crypto';
import { constants, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { delimiter, extname, join } from 'node:path';
import { parsePdfDocument } from './pdf-parser.js';
import {
  CompositeOcrAdapter,
  FormulaAwareOcrAdapter,
  LlmOcrAdapter,
  PaddleOcrAdapter,
  ensureTextBlocks,
  validateOcrImage,
} from './ocr-adapter.js';
import { loadEnhancedOcrConfig } from './ocr-config.js';
import { VisionEnhancedOcrAdapter } from './enhanced-ocr-adapter.js';
import { buildDraft, DEFAULT_TIMEOUT_MS, withTimeout } from './url-collector.js';
import { defaultTranscriber, AudioTranscriptionError, DEFAULT_AUDIO_LIMITS } from './audio-transcriber.js';
import { extractAudio, extractKeyFrames } from './video-extractor.js';
import type { AudioTranscriber } from './audio-transcriber.js';
import type { OcrAdapter } from './ocr-adapter.js';
import type { CollectorContext } from '../types.js';
import type {
  MaterialRouteMetadata,
  MultimodalCollectInput,
  MultimodalRouteResult,
  MultimodalTextFragment,
  UploadRouteChannel,
  UploadRouteDecision,
} from '../types.js';

export type MediaCategory = 'pdf' | 'image' | 'video' | 'audio' | 'text' | 'unknown';

const VIDEO_FRAME_INTERVAL_SECONDS = 30;

const EXTENSION_CHANNELS: Record<string, UploadRouteChannel> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.wav': 'audio',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.flac': 'audio',
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.mkv': 'video',
  '.pdf': 'document',
  '.txt': 'document',
  '.md': 'document',
  '.markdown': 'document',
  '.json': 'document',
};

export interface MultimodalRouterConfig {
  ocrAdapter?: OcrAdapter;
  audioTranscriber?: AudioTranscriber;
  /** FR-A02 FR-A AC2 - enable formula-aware OCR by wrapping the chosen base adapter. Default: true. */
  enableFormulaDetection?: boolean;
  /** FR-A02 FR-A AC3 - enable enhanced OCR fallback channel. When unset, defaults to whatever loadEnhancedOcrConfig() returns. */
  enhancedOcrAdapter?: OcrAdapter | null;
  /** Override the openclaw.json path used to discover the enhanced channel. */
  openclawJsonPath?: string;
  /** Override low-confidence threshold passed to CompositeOcrAdapter. */
  lowConfidenceThreshold?: number;
}

export class MultimodalRouter {
  private readonly ocrAdapter: OcrAdapter | null;
  private readonly audioTranscriber: AudioTranscriber;
  private readonly enableFormulaDetection: boolean;
  private readonly enhancedOcrAdapter: OcrAdapter | null;
  private readonly openclawJsonPath: string | undefined;
  private readonly lowConfidenceThreshold: number | undefined;
  private discoveredEnhancedOcrConfig: ReturnType<typeof loadEnhancedOcrConfig> | undefined;

  constructor(config?: MultimodalRouterConfig) {
    this.ocrAdapter = config?.ocrAdapter ?? null;
    this.audioTranscriber = config?.audioTranscriber ?? defaultTranscriber;
    this.enableFormulaDetection = config?.enableFormulaDetection ?? true;
    // `null` = explicitly disabled; `undefined` = auto-discover from config.
    this.enhancedOcrAdapter = config?.enhancedOcrAdapter ?? null;
    this.openclawJsonPath = config?.openclawJsonPath;
    this.lowConfidenceThreshold = config?.lowConfidenceThreshold;
  }

  categorize(mimeType: string): MediaCategory {
    const channel = routeChannelByMime(mimeType);
    if (channel === 'document') return categoryFromDocumentMime(normalizeMime(mimeType));
    return categoryFromRouteChannel(channel);
  }

  decideRoute(input: Pick<MultimodalCollectInput, 'fileName' | 'mimeType'>): UploadRouteDecision {
    const mimeType = normalizeMime(input.mimeType);
    const extension = extname(input.fileName).toLowerCase() || undefined;
    const mimeChannel = routeChannelByMime(mimeType);
    const extensionChannel = extension ? EXTENSION_CHANNELS[extension] : undefined;
    const channel = mimeChannel ?? extensionChannel ?? 'unsupported';
    const conflict = Boolean(mimeChannel && extensionChannel && mimeChannel !== extensionChannel);
    const conflictLog = conflict
      ? `mime/extension conflict for ${input.fileName}: mime=${mimeType} -> ${mimeChannel}; extension=${extension} -> ${extensionChannel}; mime wins`
      : undefined;

    return {
      channel,
      status: channel === 'unsupported' ? 'unsupported' : 'ready',
      mimeType,
      extension,
      conflict,
      conflictLog,
      parseParams: parseParamsForChannel(channel),
      userMessage: channel === 'unsupported'
        ? `不支持的素材类型：${mimeType || 'unknown'}${extension ? `（${extension}）` : ''}。支持图片、音频、视频、PDF、Markdown、纯文本和 JSON。`
        : undefined,
    };
  }

  persistMaterialRoute(input: MultimodalCollectInput, route: UploadRouteDecision, context: CollectorContext): MaterialRouteMetadata {
    const now = (context.now ?? new Date()).toISOString();
    const content = toUint8Array(input.content);
    const sourceChannel = input.sourceChannel?.trim() || 'web';
    const storagePath = input.sourceMediaPath ?? stableStoragePath(input, route);

    return {
      materialId: stableMaterialId(input, route),
      fileName: input.fileName,
      mimeType: route.mimeType,
      fileSize: content.byteLength,
      status: route.status,
      spaceId: input.spaceId ?? 'default',
      storagePath,
      sourceChannel,
      sourceRef: input.sourceRef,
      route,
      errorMessage: route.status === 'unsupported' ? route.userMessage : undefined,
      createdAt: now,
      updatedAt: now,
    };
  }

  async route(input: MultimodalCollectInput, context: CollectorContext): Promise<MultimodalRouteResult> {
    const route = this.decideRoute(input);
    const material = this.persistMaterialRoute(input, route, context);
    if (route.channel === 'unsupported') return this.unsupportedResult(input, route, material);

    const category = route.channel === 'document'
      ? categoryFromDocumentRoute(route.mimeType, route.extension)
      : categoryFromRouteChannel(route.channel);

    switch (category) {
      case 'pdf':
        return attachRoute(await this.handlePdf(input, context), route, material);
      case 'image':
        return attachRoute(await this.handleImage(input, context), route, material);
      case 'text':
        return attachRoute(await this.handleText(input, context), route, material);
      case 'video':
        return attachRoute(await this.handleVideo(input, context), route, material);
      case 'audio':
        return attachRoute(await this.handleAudio(input, context), route, material);
      default:
        return this.unsupportedResult(input, route, material);
    }
  }

  private async handlePdf(input: MultimodalCollectInput, context: CollectorContext): Promise<MultimodalRouteResult> {
    const bytes = toUint8Array(input.content);
    const parsed = await parsePdfDocument(bytes);
    const pageFragments: MultimodalTextFragment[] = parsed.pages
      .filter((p) => p.text.trim().length > 0)
      .map((p, index) => ({
        text: p.text,
        sourceMediaPath: input.sourceMediaPath,
        frameIndex: index + 1,
      }));
    const textContent = pageFragments.map((fragment) => fragment.text).join('\n\n');

    const meta: Record<string, unknown> = { ...parsed.metadata, fragments: pageFragments.length };

    if (!textContent.trim()) {
      return {
        category: 'pdf',
        extractedText: '',
        metadata: meta,
        warnings: ['PDF contains no extractable text. It may be image-based; consider OCR.'],
        fragments: [],
      };
    }

    const draft = await buildDraft(
      {
        title: parsed.metadata.title ?? input.fileName.replace(/\.pdf$/i, ''),
        content: textContent,
        spaceId: input.spaceId,
        source: {
          type: 'document',
          fileName: input.fileName,
          mimeType: 'application/pdf',
          collectedAt: (context.now ?? new Date()).toISOString(),
        },
      },
      context,
    );

    return {
      category: 'pdf',
      extractedText: textContent,
      metadata: meta,
      draft,
      warnings: [],
      fragments: pageFragments,
    };
  }

  private async handleImage(input: MultimodalCollectInput, context: CollectorContext): Promise<MultimodalRouteResult> {
    const buffer = Buffer.from(toUint8Array(input.content));

    // FR-A02 FR-A AC5 - cheap pre-OCR validation. Reject empty / non-image bytes
    // up-front rather than letting them rot in "解析中" state.
    const validationFailure = validateOcrImage(buffer);
    if (validationFailure) {
      return {
        category: 'image',
        extractedText: '',
        metadata: {
          confidence: 0,
          sourceMediaPath: input.sourceMediaPath,
          failureReason: validationFailure,
          textBlocks: [],
        },
        warnings: [`Image rejected: ${validationFailure}`],
        fragments: [],
      };
    }

    // Compose the OCR pipeline:
    //   base = selectDefaultOcrAdapter (unchanged)
    //   wrap with FormulaAwareOcrAdapter if enabled
    //   wrap with CompositeOcrAdapter if enhanced channel is configured
    let adapter: OcrAdapter = this.ocrAdapter ?? selectDefaultOcrAdapter(context);
    if (this.enableFormulaDetection && !this.ocrAdapter) {
      adapter = new FormulaAwareOcrAdapter({
        base: adapter,
        llm: context.llm,
        model: context.model,
      });
    }
    const enhancedAdapter = this.resolveEnhancedAdapter();
    if (enhancedAdapter) {
      adapter = new CompositeOcrAdapter({
        primary: adapter,
        enhanced: enhancedAdapter,
        lowConfidenceThreshold: this.resolveLowConfidenceThreshold(),
      });
    }

    const imageId = input.sourceRef?.trim() || input.fileName;
    let ocrResult;
    try {
      ocrResult = await withTimeout(
        (signal) => adapter.recognize(buffer, { signal, language: 'zh', imageId }),
        context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        'Image OCR',
      );
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      // Distinguish "engine unreachable / timeout" from input issues so AC5
      // surfaces the right failure category to the UI.
      return {
        category: 'image',
        extractedText: '',
        metadata: {
          confidence: 0,
          sourceMediaPath: input.sourceMediaPath,
          failureReason: 'ocr_engine_unavailable',
          textBlocks: [],
        },
        warnings: [`Image OCR failed: ${reason}`],
        fragments: [],
      };
    }

    // Always normalize result shape so downstream gets `textBlocks`.
    const normalized = ensureTextBlocks(ocrResult, { source: 'primary', imageId });
    const textBlocks = normalized.textBlocks ?? [];
    const hasFormulaBlock = textBlocks.some((b) => b.type === 'formula');

    if (!normalized.text.trim()) {
      const failureReason = normalized.failureReason
        ?? (textBlocks.length === 0 ? 'image_empty' : 'ocr_low_confidence');
      return {
        category: 'image',
        extractedText: '',
        metadata: {
          confidence: normalized.confidence,
          sourceMediaPath: input.sourceMediaPath,
          failureReason,
          textBlocks,
        },
        warnings: ['OCR produced no text from image.', ...(normalized.warnings ?? [])],
        fragments: [],
      };
    }

    // FR-A02 FR-A AC1/AC2/AC4 - persist textBlocks (with bbox + type) and per-block fragments
    // so downstream knowledge entries can link back to the source region.
    const fragments: MultimodalTextFragment[] = textBlocks.length
      ? textBlocks.map((block) => ({
          text: block.text,
          sourceMediaPath: input.sourceMediaPath,
          coordinates: block.bbox,
        }))
      : [{ text: normalized.text, sourceMediaPath: input.sourceMediaPath }];

    let draft: Awaited<ReturnType<typeof buildDraft>> | undefined;
    const warnings: string[] = [...(normalized.warnings ?? [])];
    try {
      draft = await buildDraft(
        {
          title: input.fileName.replace(/\.[^.]+$/, ''),
          content: normalized.text,
          spaceId: input.spaceId,
          source: {
            type: 'document',
            fileName: input.fileName,
            mimeType: input.mimeType,
            collectedAt: (context.now ?? new Date()).toISOString(),
          },
        },
        context,
      );
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Draft generation failed: ${reason}`);
    }

    return {
      category: 'image',
      extractedText: normalized.text,
      metadata: {
        confidence: normalized.confidence,
        language: normalized.language,
        sourceMediaPath: input.sourceMediaPath,
        blocks: normalized.blocks ?? [],
        textBlocks,
        hasFormula: hasFormulaBlock,
        imageId,
      },
      draft,
      warnings,
      fragments,
    };
  }

  private resolveEnhancedAdapter(): OcrAdapter | null {
    if (this.enhancedOcrAdapter) return this.enhancedOcrAdapter;
    const cfg = this.resolveEnhancedConfig();
    if (!cfg || !cfg.endpoint || !cfg.model) return null;
    return new VisionEnhancedOcrAdapter({
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey,
      model: cfg.model,
    });
  }

  private resolveEnhancedConfig(): ReturnType<typeof loadEnhancedOcrConfig> {
    if (this.discoveredEnhancedOcrConfig !== undefined) return this.discoveredEnhancedOcrConfig;
    this.discoveredEnhancedOcrConfig = loadEnhancedOcrConfig({ openclawJsonPath: this.openclawJsonPath });
    return this.discoveredEnhancedOcrConfig;
  }

  private resolveLowConfidenceThreshold(): number | undefined {
    return this.lowConfidenceThreshold ?? this.resolveEnhancedConfig()?.lowConfidenceThreshold;
  }

  private async handleText(input: MultimodalCollectInput, context: CollectorContext): Promise<MultimodalRouteResult> {
    const text = typeof input.content === 'string'
      ? input.content
      : new TextDecoder().decode(toUint8Array(input.content));

    const draft = await buildDraft(
      {
        title: input.fileName.replace(/\.[^.]+$/, ''),
        content: text,
        spaceId: input.spaceId,
        source: {
          type: 'document',
          fileName: input.fileName,
          mimeType: input.mimeType,
          collectedAt: (context.now ?? new Date()).toISOString(),
        },
      },
      context,
    );

    return {
      category: 'text',
      extractedText: text,
      metadata: { sourceMediaPath: input.sourceMediaPath },
      draft,
      warnings: [],
      fragments: [{ text, sourceMediaPath: input.sourceMediaPath }],
    };
  }

  private async handleAudio(input: MultimodalCollectInput, context: CollectorContext): Promise<MultimodalRouteResult> {
    const buffer = Buffer.from(toUint8Array(input.content));

    let transcription;
    try {
      transcription = await this.audioTranscriber.transcribe(buffer, {
        language: 'zh',
        model: 'tiny',
        includeSegments: true,
        sourceMediaPath: input.sourceMediaPath,
        maxFileSizeBytes: DEFAULT_AUDIO_LIMITS.maxFileSizeBytes,
        maxSegmentDurationSeconds: DEFAULT_AUDIO_LIMITS.maxSegmentDurationSeconds,
      });
    } catch (error: unknown) {
      const failure = normalizeAudioTranscriptionFailure(error, input.sourceMediaPath);
      return {
        category: 'audio',
        extractedText: '',
        metadata: {
          sourceMediaPath: input.sourceMediaPath,
          originalAudioDownloadPath: input.sourceMediaPath,
          failureCode: failure.code,
          failureReason: failure.reason,
        },
        warnings: [failure.message],
        fragments: [],
      };
    }

    if (!transcription.text.trim()) {
      return {
        category: 'audio',
        extractedText: '',
        metadata: { durationSeconds: transcription.durationSeconds, sourceMediaPath: input.sourceMediaPath },
        warnings: ['Audio transcription produced no text.'],
        fragments: [],
      };
    }

    const fragments = audioFragments(transcription, input.sourceMediaPath);
    let draft: Awaited<ReturnType<typeof buildDraft>> | undefined;
    const warnings: string[] = [];
    try {
      draft = await buildDraft(
        {
          title: input.fileName.replace(/\.[^.]+$/, ''),
          content: transcription.text,
          spaceId: input.spaceId,
          source: {
            type: 'document',
            fileName: input.fileName,
            mimeType: input.mimeType,
            collectedAt: (context.now ?? new Date()).toISOString(),
          },
        },
        context,
      );
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Draft generation failed: ${reason}`);
    }

    return {
      category: 'audio',
      extractedText: transcription.text,
      metadata: {
        language: transcription.language,
        durationSeconds: transcription.durationSeconds,
        segments: transcription.segments,
        sourceMediaPath: input.sourceMediaPath,
      },
      draft,
      warnings,
      fragments,
    };
  }

  private async handleVideo(input: MultimodalCollectInput, context: CollectorContext): Promise<MultimodalRouteResult> {
    const videoBuffer = Buffer.from(toUint8Array(input.content));
    const warnings: string[] = [];
    const frameDir = input.sourceMediaPath ? `${input.sourceMediaPath}.frames` : undefined;

    let audioBuffer: Buffer;
    try {
      audioBuffer = await extractAudio(videoBuffer, input.fileName);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        category: 'video',
        extractedText: '',
        metadata: { sourceMediaPath: input.sourceMediaPath },
        warnings: [`Video audio extraction failed: ${reason}`],
        fragments: [],
      };
    }

    let transcription;
    try {
      transcription = await this.audioTranscriber.transcribe(audioBuffer, {
        language: 'zh',
        model: 'tiny',
        includeSegments: true,
        sourceMediaPath: input.sourceMediaPath,
        maxFileSizeBytes: DEFAULT_AUDIO_LIMITS.maxFileSizeBytes,
        maxSegmentDurationSeconds: DEFAULT_AUDIO_LIMITS.maxSegmentDurationSeconds,
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        category: 'video',
        extractedText: '',
        metadata: { sourceMediaPath: input.sourceMediaPath },
        warnings: [`Video audio transcription failed: ${reason}`],
        fragments: [],
      };
    }

    let frameFragments: MultimodalTextFragment[] = [];
    try {
      if (frameDir) await mkdir(frameDir, { recursive: true });
      const frames = await extractKeyFrames(videoBuffer, input.fileName, { intervalSeconds: VIDEO_FRAME_INTERVAL_SECONDS, outputDir: frameDir });
      frameFragments = frames.map((frame) => ({
        text: `[video frame ${frame.index} at ${frame.timestampSeconds}s]`,
        sourceMediaPath: frame.path,
        frameIndex: frame.index,
        timestampSeconds: frame.timestampSeconds,
      }));
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Video key frame extraction failed: ${reason}`);
    }

    if (!transcription.text.trim() && frameFragments.length === 0) {
      return {
        category: 'video',
        extractedText: '',
        metadata: { durationSeconds: transcription.durationSeconds, sourceMediaPath: input.sourceMediaPath },
        warnings: ['Video audio transcription produced no text.', ...warnings],
        fragments: [],
      };
    }

    const fragments = [...audioFragments(transcription, input.sourceMediaPath), ...frameFragments];
    const contentParts = [transcription.text.trim(), ...frameFragments.map((fragment) => fragment.text)].filter(Boolean);
    const extractedText = contentParts.join('\n\n');

    let draft: Awaited<ReturnType<typeof buildDraft>> | undefined;
    try {
      draft = await buildDraft(
        {
          title: input.fileName.replace(/\.[^.]+$/, ''),
          content: extractedText,
          spaceId: input.spaceId,
          source: {
            type: 'document',
            fileName: input.fileName,
            mimeType: input.mimeType,
            collectedAt: (context.now ?? new Date()).toISOString(),
          },
        },
        context,
      );
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Draft generation failed: ${reason}`);
    }

    return {
      category: 'video',
      extractedText,
      metadata: {
        language: transcription.language,
        durationSeconds: transcription.durationSeconds,
        segments: transcription.segments,
        sourceMediaPath: input.sourceMediaPath,
        frameDir,
        frameCount: frameFragments.length,
      },
      draft,
      warnings,
      fragments,
    };
  }

  private unsupportedResult(
    input: MultimodalCollectInput,
    route: UploadRouteDecision,
    material: MaterialRouteMetadata,
  ): MultimodalRouteResult {
    return {
      category: 'unknown',
      route,
      material,
      extractedText: '',
      metadata: {
        mimeType: route.mimeType,
        sourceMediaPath: input.sourceMediaPath,
        status: 'unsupported',
        routeChannel: route.channel,
        parseParams: route.parseParams,
      },
      warnings: [route.userMessage
        ? `${route.userMessage} unsupported processing is not yet implemented.`
        : `Unsupported material type: ${route.mimeType || 'unknown'}. Supported types are PDF, text, images, audio, and video. unsupported processing is not yet implemented.`],
      fragments: [],
    };
  }
}

function attachRoute(
  result: MultimodalRouteResult,
  route: UploadRouteDecision,
  material: MaterialRouteMetadata,
): MultimodalRouteResult {
  return {
    ...result,
    route,
    material,
    metadata: {
      ...result.metadata,
      routeChannel: route.channel,
      parseParams: route.parseParams,
      routeConflict: route.conflict,
      routeConflictLog: route.conflictLog,
      materialId: material.materialId,
      sourceChannel: material.sourceChannel,
      sourceRef: material.sourceRef,
      routeStatus: route.status,
    },
    warnings: route.conflictLog ? [route.conflictLog, ...result.warnings] : result.warnings,
  };
}

function selectDefaultOcrAdapter(context: CollectorContext): OcrAdapter {
  if (isExecutableOnPath('paddleocr')) return new PaddleOcrAdapter();
  return new LlmOcrAdapter({ llm: context.llm, model: context.model });
}

function isExecutableOnPath(command: string): boolean {
  const pathValue = process.env.PATH ?? '';
  if (!pathValue.trim()) return false;

  return pathValue.split(delimiter).some((dir) => {
    if (!dir) return false;
    const candidate = join(dir, command);
    try {
      if (!existsSync(candidate)) return false;
      const stats = statSync(candidate);
      return stats.isFile() && Boolean(stats.mode & constants.X_OK);
    } catch {
      return false;
    }
  });
}

function routeChannelByMime(mimeType: string): UploadRouteChannel | undefined {
  const normalized = normalizeMime(mimeType);
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized === 'application/pdf' || normalized.startsWith('text/') || normalized === 'application/json') return 'document';
  return undefined;
}

function categoryFromRouteChannel(channel?: UploadRouteChannel): MediaCategory {
  if (channel === 'image') return 'image';
  if (channel === 'audio') return 'audio';
  if (channel === 'video') return 'video';
  return 'unknown';
}

function categoryFromDocumentMime(mimeType: string): MediaCategory {
  return mimeType === 'application/pdf' ? 'pdf' : 'text';
}

function categoryFromDocumentRoute(mimeType: string, extension?: string): MediaCategory {
  return mimeType === 'application/pdf' || extension === '.pdf' ? 'pdf' : 'text';
}

function parseParamsForChannel(channel: UploadRouteChannel): Record<string, unknown> {
  if (channel === 'video') return { audioModel: 'tiny', audioLanguage: 'zh', frameIntervalSeconds: VIDEO_FRAME_INTERVAL_SECONDS };
  if (channel === 'audio') return { model: 'tiny', language: 'zh', includeSegments: true };
  if (channel === 'image') return { ocrLanguage: 'zh', preserveCoordinates: true };
  if (channel === 'document') return { preservePageFragments: true };
  return {};
}

function normalizeMime(mimeType: string): string {
  return (mimeType || '').split(';', 1)[0].trim().toLowerCase();
}

function stableMaterialId(input: MultimodalCollectInput, route: UploadRouteDecision): string {
  if (input.sourceRef?.trim()) return `material-${hashText(input.sourceRef.trim())}`;
  return `material-${hashText([input.fileName, route.mimeType, toUint8Array(input.content).byteLength].join('|'))}`;
}

function stableStoragePath(input: MultimodalCollectInput, route: UploadRouteDecision): string {
  return join('uploads', 'wiki-materials', `${stableMaterialId(input, route)}-${input.fileName || randomUUID()}`);
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeAudioTranscriptionFailure(error: unknown, sourceMediaPath?: string): { code: string; reason: string; message: string } {
  const code = error instanceof AudioTranscriptionError ? error.code : 'transcription_failed';
  const reason = error instanceof Error ? error.message : String(error);
  const originalPath = error instanceof AudioTranscriptionError ? error.originalAudioPath ?? sourceMediaPath : sourceMediaPath;
  const downloadHint = originalPath ? ` 原始音频保留在 ${originalPath}，可下载后人工核对或换通道重试。` : '';
  return {
    code,
    reason,
    message: `Audio transcription failed [${code}]: ${reason}${downloadHint}`,
  };
}

function audioFragments(
  transcription: { text: string; segments?: Array<{ start: number; end: number; text: string }> },
  sourceMediaPath?: string,
): MultimodalTextFragment[] {
  if (transcription.segments?.length) {
    return transcription.segments
      .filter((segment) => segment.text.trim().length > 0)
      .map((segment) => ({
        text: segment.text,
        startSeconds: segment.start,
        endSeconds: segment.end,
        sourceMediaPath,
      }));
  }
  return [{ text: transcription.text, sourceMediaPath }];
}

function toUint8Array(content: string | Uint8Array | Buffer): Uint8Array {
  if (content instanceof Uint8Array) return content;
  return new TextEncoder().encode(content);
}
