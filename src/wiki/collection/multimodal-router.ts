/**
 * FR-1 AC-1.2, NFR-1
 * FR-A02 FR-D
 * Multimodal router: decide one stable upload route, persist route metadata,
 * and dispatch content to the appropriate parser based on MIME-first routing.
 */

import { randomUUID } from 'node:crypto';
import { constants, existsSync, statSync } from 'node:fs';
import { mkdir, readFile as fsReadFile } from 'node:fs/promises';
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
  VideoChannelFailure,
  VideoChannelName,
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
    const channelFailures: VideoChannelFailure[] = [];
    const frameDir = input.sourceMediaPath ? `${input.sourceMediaPath}.frames` : undefined;
    const shouldRunAudio = !input.retryChannel || input.retryChannel === 'audio';
    const shouldRunKeyframe = !input.retryChannel || input.retryChannel === 'keyframe';

    // ─── FR-C AC1: Extract audio track and transcribe (reuses FR-B) ───
    let audioBuffer: Buffer | null = null;
    let transcription: { text: string; language?: string; durationSeconds?: number; segments?: Array<{ start: number; end: number; text: string }> } | null = null;

    if (shouldRunAudio) {
      try {
        audioBuffer = await extractAudio(videoBuffer, input.fileName);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        channelFailures.push({ channel: 'audio', status: 'failed', reason: `Audio extraction failed: ${reason}` });
        warnings.push(`Video audio extraction failed: ${reason}`);
      }

      if (audioBuffer) {
        try {
          transcription = await this.audioTranscriber.transcribe(audioBuffer, {
            language: 'zh',
            model: 'tiny',
            includeSegments: true,
            sourceMediaPath: input.sourceMediaPath,
            maxFileSizeBytes: DEFAULT_AUDIO_LIMITS.maxFileSizeBytes,
            maxSegmentDurationSeconds: DEFAULT_AUDIO_LIMITS.maxSegmentDurationSeconds,
          });
          channelFailures.push({ channel: 'audio', status: 'success' });
        } catch (error: unknown) {
          const reason = error instanceof Error ? error.message : String(error);
          channelFailures.push({ channel: 'audio', status: 'failed', reason: `Transcription failed: ${reason}` });
          warnings.push(`Video audio transcription failed: ${reason}`);
        }
      }
    } else {
      channelFailures.push({ channel: 'audio', status: 'skipped', reason: 'Skipped because retryChannel=keyframe' });
    }

    // ─── FR-C AC2: Extract key frames and OCR each (reuses FR-A) ───
    let frameFragments: MultimodalTextFragment[] = [];
    if (shouldRunKeyframe) {
      try {
        if (frameDir) await mkdir(frameDir, { recursive: true });
        const frames = await extractKeyFrames(videoBuffer, input.fileName, {
          intervalSeconds: VIDEO_FRAME_INTERVAL_SECONDS,
          outputDir: frameDir,
        });

        // OCR each extracted frame using the same adapter pipeline as handleImage
        let adapter: OcrAdapter = this.ocrAdapter ?? selectDefaultOcrAdapter(context);
        if (this.enableFormulaDetection && !this.ocrAdapter) {
          adapter = new FormulaAwareOcrAdapter({ base: adapter, llm: context.llm, model: context.model });
        }
        const enhancedAdapter = this.resolveEnhancedAdapter();
        if (enhancedAdapter) {
          adapter = new CompositeOcrAdapter({
            primary: adapter,
            enhanced: enhancedAdapter,
            lowConfidenceThreshold: this.resolveLowConfidenceThreshold(),
          });
        }

        for (const frame of frames) {
          try {
            const frameBuffer = await fsReadFile(frame.path);
            const validation = validateOcrImage(frameBuffer);
            if (validation) {
              continue;
            }
            const ocrResult = await adapter.recognize(frameBuffer, { language: 'zh', imageId: `frame-${frame.index}` });
            const normalized = ensureTextBlocks(ocrResult, { source: 'primary', imageId: `frame-${frame.index}` });
            if (normalized.text.trim()) {
              frameFragments.push({
                text: normalized.text.trim(),
                sourceMediaPath: frame.path,
                frameIndex: frame.index,
                timestampSeconds: frame.timestampSeconds,
                channel: 'keyframe',
                coordinates: normalized.textBlocks?.[0]?.bbox,
              });
            }
          } catch (frameError: unknown) {
            const reason = frameError instanceof Error ? frameError.message : String(frameError);
            warnings.push(`Frame ${frame.index} OCR failed: ${reason}`);
          }
        }
        channelFailures.push({ channel: 'keyframe', status: frameFragments.length > 0 ? 'success' : 'failed', reason: frameFragments.length === 0 ? 'No text extracted from any frame' : undefined });
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        channelFailures.push({ channel: 'keyframe', status: 'failed', reason: `Key frame extraction failed: ${reason}` });
        warnings.push(`Video key frame extraction failed: ${reason}`);
      }
    } else {
      channelFailures.push({ channel: 'keyframe', status: 'skipped', reason: 'Skipped because retryChannel=audio' });
    }

    // Both channels failed completely
    if (!transcription?.text?.trim() && frameFragments.length === 0) {
      return {
        category: 'video',
        extractedText: '',
        metadata: { sourceMediaPath: input.sourceMediaPath, channelFailures },
        warnings: ['Video processing produced no text from either channel.', ...warnings],
        fragments: [],
        channelFailures,
      };
    }

    // ─── FR-C AC3: Merge dual-channel results on unified timeline + dedup ───
    const audioFrags = transcription ? audioFragmentsWithChannel(transcription, input.sourceMediaPath) : [];
    const allFragments = mergeDualChannelFragments(audioFrags, frameFragments);

    // Build combined text (audio transcription first, then unique frame OCR content)
    const audioText = transcription?.text?.trim() || '';
    const uniqueFrameTexts = allFragments
      .filter((fragment) => fragment.channel === 'keyframe' && !fragment.duplicateMarker)
      .map((f) => `[${f.timestampSeconds ?? 0}s frame${f.frameIndex ?? ''}] ${f.text}`)
      .filter(Boolean);
    const extractedText = [audioText, ...uniqueFrameTexts].filter(Boolean).join('\n\n');

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
        language: transcription?.language,
        durationSeconds: transcription?.durationSeconds,
        segments: transcription?.segments,
        sourceMediaPath: input.sourceMediaPath,
        frameDir,
        frameCount: frameFragments.length,
        channelFailures,
      },
      draft,
      warnings,
      fragments: allFragments,
      channelFailures,
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

/**
 * FR-C AC1 - audio fragments with channel annotation for dual-channel merge.
 */
export function audioFragmentsWithChannel(
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
        channel: 'audio' as const,
      }));
  }
  if (transcription.text.trim()) {
    return [{ text: transcription.text, sourceMediaPath, channel: 'audio' as const }];
  }
  return [];
}

/**
 * FR-C AC3 - Merge audio and keyframe fragments on a unified timeline.
 * When an audio segment and a keyframe fragment overlap in time and share
 * substantial textual content, the keyframe fragment is marked as a duplicate
 * to avoid redundant knowledge entries downstream.
 *
 * Dedup uses normalized character overlap (not keyword matching / regex).
 * This is a lightweight heuristic suitable for detecting when a speaker reads
 * exactly what's on a slide. It does NOT use FTS5 or regex to fake semantic
 * understanding — it compares normalized character sequences.
 */
export function mergeDualChannelFragments(
  audioFrags: MultimodalTextFragment[],
  frameFrags: MultimodalTextFragment[],
): MultimodalTextFragment[] {
  // Mark frame fragments that are substantially duplicated by audio content
  const markedFrameFrags = frameFrags.map((frame) => {
    const frameTs = frame.timestampSeconds ?? 0;
    // Find audio segments that overlap this frame's time window (±15s tolerance)
    const overlapping = audioFrags.filter((audio) => {
      const audioStart = audio.startSeconds ?? 0;
      const audioEnd = audio.endSeconds ?? audioStart;
      return audioStart <= frameTs + 15 && audioEnd >= frameTs - 15;
    });
    if (overlapping.length === 0) return frame;

    // Check character overlap ratio between frame text and overlapping audio
    const frameNorm = normalizeForDedup(frame.text);
    const audioNorm = normalizeForDedup(overlapping.map((a) => a.text).join(''));
    const overlap = charOverlapRatio(frameNorm, audioNorm);

    if (overlap >= 0.6) {
      // Mark as duplicate — same knowledge expressed in both channels
      return { ...frame, duplicateMarker: `audio-overlap-${Math.round(overlap * 100)}pct` };
    }
    return frame;
  });

  // Merge all fragments sorted by time
  const all = [...audioFrags, ...markedFrameFrags];
  all.sort((a, b) => {
    const timeA = a.startSeconds ?? a.timestampSeconds ?? 0;
    const timeB = b.startSeconds ?? b.timestampSeconds ?? 0;
    return timeA - timeB;
  });
  return all;
}

/** Normalize text for dedup comparison: strip whitespace, punctuation, lowercase. */
export function normalizeForDedup(text: string): string {
  return text
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/** Character-level overlap ratio: how much of `a` appears in `b`. */
export function charOverlapRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  // Use character bigrams for more robust matching
  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  if (bigramsA.size === 0) return 0;

  let matches = 0;
  for (const bigram of bigramsA) {
    if (b.includes(bigram)) matches++;
  }
  return matches / bigramsA.size;
}

function toUint8Array(content: string | Uint8Array | Buffer): Uint8Array {
  if (content instanceof Uint8Array) return content;
  return new TextEncoder().encode(content);
}
