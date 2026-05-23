/**
 * FR-1 AC-1.2, NFR-1
 * Multimodal router: dispatch content to the appropriate handler based on MIME type.
 */

import { parsePdfDocument } from './pdf-parser.js';
import { LlmOcrAdapter } from './ocr-adapter.js';
import { buildDraft, DEFAULT_TIMEOUT_MS, withTimeout } from './url-collector.js';
import { defaultTranscriber } from './audio-transcriber.js';
import { extractAudio } from './video-extractor.js';
import type { AudioTranscriber } from './audio-transcriber.js';
import type { OcrAdapter } from './ocr-adapter.js';
import type { CollectorContext, WikiCollectionResult } from '../types.js';
import type { MultimodalCollectInput, MultimodalRouteResult } from '../types.js';

export type MediaCategory = 'pdf' | 'image' | 'video' | 'audio' | 'text' | 'unknown';

export interface MultimodalRouterConfig {
  ocrAdapter?: OcrAdapter;
  audioTranscriber?: AudioTranscriber;
}

export class MultimodalRouter {
  private readonly ocrAdapter: OcrAdapter | null;
  private readonly audioTranscriber: AudioTranscriber;

  constructor(config?: MultimodalRouterConfig) {
    this.ocrAdapter = config?.ocrAdapter ?? null;
    this.audioTranscriber = config?.audioTranscriber ?? defaultTranscriber;
  }

  categorize(mimeType: string): MediaCategory {
    const normalized = mimeType.toLowerCase().trim();
    if (normalized === 'application/pdf') return 'pdf';
    if (normalized.startsWith('image/')) return 'image';
    if (normalized.startsWith('video/')) return 'video';
    if (normalized.startsWith('audio/')) return 'audio';
    if (normalized.startsWith('text/') || normalized === 'application/json') return 'text';
    return 'unknown';
  }

  async route(input: MultimodalCollectInput, context: CollectorContext): Promise<MultimodalRouteResult> {
    const category = this.categorize(input.mimeType);

    switch (category) {
      case 'pdf':
        return this.handlePdf(input, context);
      case 'image':
        return this.handleImage(input, context);
      case 'text':
        return this.handleText(input, context);
      case 'video':
        return this.handleVideo(input, context);
      case 'audio':
        return this.handleAudio(input, context);
      default:
        return this.stubResult(input, 'unknown');
    }
  }

  private async handlePdf(input: MultimodalCollectInput, context: CollectorContext): Promise<MultimodalRouteResult> {
    const bytes = toUint8Array(input.content);
    const parsed = await parsePdfDocument(bytes);
    const textContent = parsed.pages
      .filter((p) => p.text.length > 0)
      .map((p) => p.text)
      .join('\n\n');

    const meta: Record<string, unknown> = { ...parsed.metadata };

    if (!textContent.trim()) {
      return {
        category: 'pdf',
        extractedText: '',
        metadata: meta,
        warnings: ['PDF contains no extractable text. It may be image-based; consider OCR.'],
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
    };
  }

  private async handleImage(input: MultimodalCollectInput, context: CollectorContext): Promise<MultimodalRouteResult> {
    const adapter = this.ocrAdapter ?? new LlmOcrAdapter({ llm: context.llm, model: context.model });
    const buffer = Buffer.from(toUint8Array(input.content));

    let ocrResult;
    try {
      ocrResult = await withTimeout(
        (signal) => adapter.recognize(buffer, { signal }),
        context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        'Image OCR',
      );
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        category: 'image',
        extractedText: '',
        metadata: { confidence: 0 },
        warnings: [`Image OCR failed: ${reason}`],
      };
    }

    if (!ocrResult.text.trim()) {
      return {
        category: 'image',
        extractedText: '',
        metadata: { confidence: ocrResult.confidence },
        warnings: ['OCR produced no text from image.'],
      };
    }

    let draft: Awaited<ReturnType<typeof buildDraft>> | undefined;
    const warnings: string[] = [];
    try {
      draft = await buildDraft(
        {
          title: input.fileName.replace(/\.[^.]+$/, ''),
          content: ocrResult.text,
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
      extractedText: ocrResult.text,
      metadata: { confidence: ocrResult.confidence, language: ocrResult.language },
      draft,
      warnings,
    };
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
      metadata: {},
      draft,
      warnings: [],
    };
  }

  private async handleAudio(input: MultimodalCollectInput, context: CollectorContext): Promise<MultimodalRouteResult> {
    const buffer = Buffer.from(toUint8Array(input.content));

    let transcription;
    try {
      transcription = await this.audioTranscriber.transcribe(buffer, {
        language: 'zh',
        model: 'base',
        includeSegments: true,
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        category: 'audio',
        extractedText: '',
        metadata: {},
        warnings: [`Audio transcription failed: ${reason}`],
      };
    }

    if (!transcription.text.trim()) {
      return {
        category: 'audio',
        extractedText: '',
        metadata: { durationSeconds: transcription.durationSeconds },
        warnings: ['Audio transcription produced no text.'],
      };
    }

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
      },
      draft,
      warnings,
    };
  }

  private async handleVideo(input: MultimodalCollectInput, context: CollectorContext): Promise<MultimodalRouteResult> {
    const videoBuffer = Buffer.from(toUint8Array(input.content));

    let audioBuffer: Buffer;
    try {
      audioBuffer = await extractAudio(videoBuffer, input.fileName);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        category: 'video',
        extractedText: '',
        metadata: {},
        warnings: [`Video audio extraction failed: ${reason}`],
      };
    }

    let transcription;
    try {
      transcription = await this.audioTranscriber.transcribe(audioBuffer, {
        language: 'zh',
        model: 'base',
        includeSegments: true,
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        category: 'video',
        extractedText: '',
        metadata: {},
        warnings: [`Video audio transcription failed: ${reason}`],
      };
    }

    if (!transcription.text.trim()) {
      return {
        category: 'video',
        extractedText: '',
        metadata: { durationSeconds: transcription.durationSeconds },
        warnings: ['Video audio transcription produced no text.'],
      };
    }

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
      category: 'video',
      extractedText: transcription.text,
      metadata: {
        language: transcription.language,
        durationSeconds: transcription.durationSeconds,
        segments: transcription.segments,
      },
      draft,
      warnings,
    };
  }

  private stubResult(_input: MultimodalCollectInput, category: MediaCategory): MultimodalRouteResult {
    return {
      category,
      extractedText: '',
      metadata: {},
      warnings: [`${category} processing is not yet implemented. Content was received but not parsed.`],
    };
  }
}

function toUint8Array(content: string | Uint8Array | Buffer): Uint8Array {
  if (content instanceof Uint8Array) return content;
  return new TextEncoder().encode(content);
}
