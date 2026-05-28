/**
 * Tests for MultimodalRouter: MIME categorization and routing logic.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MultimodalRouter } from '../multimodal-router.js';
import type { CollectorContext, MultimodalCollectInput, TranscribeOptions, TranscribeResult } from '../../types.js';
import type { OcrAdapter, OcrResult } from '../ocr-adapter.js';
import { AudioTranscriptionError } from '../audio-transcriber.js';

function makeContext(overrides?: Partial<CollectorContext>): CollectorContext {
  return {
    model: 'test-model',
    llm: {
      complete: vi.fn().mockResolvedValue(JSON.stringify({
        title: 'Test',
        summary: 'Summary',
        tags: ['test'],
        sections: [{ title: 'Overview', level: 1, content: 'Content here' }],
        links: [],
        warnings: [],
      })),
    },
    timeoutMs: 5000,
    ...overrides,
  };
}

describe('MultimodalRouter', () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  describe('categorize', () => {
    it('identifies PDF mime type', () => {
      const router = new MultimodalRouter();
      expect(router.categorize('application/pdf')).toBe('pdf');
    });

    it('identifies image mime types', () => {
      const router = new MultimodalRouter();
      expect(router.categorize('image/png')).toBe('image');
      expect(router.categorize('image/jpeg')).toBe('image');
      expect(router.categorize('image/webp')).toBe('image');
      expect(router.categorize('image/gif')).toBe('image');
    });

    it('identifies video mime types', () => {
      const router = new MultimodalRouter();
      expect(router.categorize('video/mp4')).toBe('video');
      expect(router.categorize('video/webm')).toBe('video');
    });

    it('identifies audio mime types', () => {
      const router = new MultimodalRouter();
      expect(router.categorize('audio/mpeg')).toBe('audio');
      expect(router.categorize('audio/wav')).toBe('audio');
    });

    it('identifies text mime types', () => {
      const router = new MultimodalRouter();
      expect(router.categorize('text/plain')).toBe('text');
      expect(router.categorize('text/markdown')).toBe('text');
      expect(router.categorize('application/json')).toBe('text');
    });

    it('returns unknown for unrecognized types', () => {
      const router = new MultimodalRouter();
      expect(router.categorize('application/octet-stream')).toBe('unknown');
      expect(router.categorize('application/zip')).toBe('unknown');
    });

    it('handles case-insensitive and whitespace', () => {
      const router = new MultimodalRouter();
      expect(router.categorize('  Application/PDF  ')).toBe('pdf');
      expect(router.categorize('IMAGE/PNG')).toBe('image');
    });
  });

  describe('route', () => {
    it('routes text content and produces a draft', async () => {
      const router = new MultimodalRouter();
      const context = makeContext();
      const input: MultimodalCollectInput = {
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        content: 'Hello world, this is a test document.',
        spaceId: 'space-1',
      };

      const result = await router.route(input, context);

      expect(result.category).toBe('text');
      expect(result.extractedText).toBe('Hello world, this is a test document.');
      expect(result.draft).toBeDefined();
      expect(result.warnings).toHaveLength(0);
    });

    it('routes image content through OCR adapter', async () => {
      const mockOcr: OcrAdapter = {
        recognize: vi.fn().mockResolvedValue({
          text: 'Extracted text from image',
          confidence: 0.92,
          language: 'en',
        } satisfies OcrResult),
      };

      const router = new MultimodalRouter({ ocrAdapter: mockOcr });
      const context = makeContext();
      const input: MultimodalCollectInput = {
        fileName: 'screenshot.png',
        mimeType: 'image/png',
        content: new Uint8Array([0x89, 0x50, 0x4E, 0x47]),
      };

      const result = await router.route(input, context);

      expect(result.category).toBe('image');
      expect(result.extractedText).toBe('Extracted text from image');
      expect(result.draft).toBeDefined();
      expect(mockOcr.recognize).toHaveBeenCalledOnce();
    });

    it('falls back to LLM OCR when paddleocr is not on PATH', async () => {
      process.env.PATH = '';
      const context = makeContext();
      const router = new MultimodalRouter({ enableFormulaDetection: false });
      const input: MultimodalCollectInput = {
        fileName: 'fallback.png',
        mimeType: 'image/png',
        content: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077533de400000000049454e44ae426082', 'hex'),
      };

      vi.mocked(context.llm.complete)
        .mockResolvedValueOnce('LLM OCR text')
        .mockResolvedValueOnce(JSON.stringify({
          title: 'Fallback',
          summary: 'Summary',
          tags: ['ocr'],
          sections: [{ title: 'Overview', level: 1, content: 'LLM OCR text' }],
          links: [],
          warnings: [],
        }));

      const result = await router.route(input, context);

      expect(result.category).toBe('image');
      expect(result.extractedText).toBe('LLM OCR text');
      expect(result.warnings.join('\n')).not.toContain('PaddleOCR command not found');
      expect(context.llm.complete).toHaveBeenCalledTimes(2);
    });

    it('gracefully degrades for video when ffmpeg/whisper fails', async () => {
      const router = new MultimodalRouter();
      const context = makeContext();
      const input: MultimodalCollectInput = {
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        content: new Uint8Array([0x00]),
      };

      const result = await router.route(input, context);

      expect(result.category).toBe('video');
      expect(result.extractedText).toBe('');
      expect(result.draft).toBeUndefined();
      expect(result.warnings[0]).toMatch(/Video audio extraction failed/);
    });

    it('routes audio through Whisper transcription into unified text fragments', async () => {
      const mockTranscriber = {
        transcribe: vi.fn(async (_buffer: Buffer, options?: TranscribeOptions): Promise<TranscribeResult> => ({
          text: '第一句话。第二句话。',
          language: options?.language ?? 'zh',
          durationSeconds: 4.2,
          segments: [
            { start: 0, end: 1.8, text: '第一句话。' },
            { start: 1.8, end: 4.2, text: '第二句话。' },
          ],
        })),
      };
      const router = new MultimodalRouter({ audioTranscriber: mockTranscriber });
      const context = makeContext();
      const input: MultimodalCollectInput = {
        fileName: 'lecture.wav',
        mimeType: 'audio/wav',
        content: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
        sourceMediaPath: 'uploads/lecture.wav',
      };

      const result = await router.route(input, context);

      expect(result.category).toBe('audio');
      expect(result.extractedText).toBe('第一句话。第二句话。');
      expect(result.draft).toBeDefined();
      expect(result.fragments).toEqual([
        { text: '第一句话。', startSeconds: 0, endSeconds: 1.8, sourceMediaPath: 'uploads/lecture.wav' },
        { text: '第二句话。', startSeconds: 1.8, endSeconds: 4.2, sourceMediaPath: 'uploads/lecture.wav' },
      ]);
      expect(mockTranscriber.transcribe).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({
        language: 'zh',
        model: 'tiny',
        includeSegments: true,
        sourceMediaPath: 'uploads/lecture.wav',
      }));
    });

    it('preserves original audio download path and error code on transcription failure', async () => {
      const mockTranscriber = {
        transcribe: vi.fn(async () => {
          throw new AudioTranscriptionError('whisper_unavailable', '本地 Whisper 不可用', 'uploads/original.wav');
        }),
      };
      const router = new MultimodalRouter({ audioTranscriber: mockTranscriber });
      const context = makeContext();
      const input: MultimodalCollectInput = {
        fileName: 'podcast.mp3',
        mimeType: 'audio/mpeg',
        content: new Uint8Array([0x00]),
        sourceMediaPath: 'uploads/original.wav',
      };

      const result = await router.route(input, context);

      expect(result.category).toBe('audio');
      expect(result.extractedText).toBe('');
      expect(result.metadata.failureCode).toBe('whisper_unavailable');
      expect(result.metadata.originalAudioDownloadPath).toBe('uploads/original.wav');
      expect(result.warnings[0]).toContain('可下载后人工核对或换通道重试');
    });

    it('gracefully degrades for audio when whisper is unavailable', async () => {
      const missingTranscriber = {
        transcribe: vi.fn(async () => {
          throw new AudioTranscriptionError('whisper_unavailable', '本地 Whisper 不可用');
        }),
      };
      const router = new MultimodalRouter({ audioTranscriber: missingTranscriber });
      const context = makeContext();
      const input: MultimodalCollectInput = {
        fileName: 'podcast.mp3',
        mimeType: 'audio/mpeg',
        content: new Uint8Array([0x00]),
      };

      const result = await router.route(input, context);

      expect(result.category).toBe('audio');
      expect(result.extractedText).toBe('');
      expect(result.draft).toBeUndefined();
      expect(result.warnings[0]).toMatch(/Audio transcription failed/);
    });

    it('returns stub for unknown types', async () => {
      const router = new MultimodalRouter();
      const context = makeContext();
      const input: MultimodalCollectInput = {
        fileName: 'archive.zip',
        mimeType: 'application/zip',
        content: new Uint8Array([0x50, 0x4B]),
      };

      const result = await router.route(input, context);

      expect(result.category).toBe('unknown');
      expect(result.extractedText).toBe('');
      expect(result.draft).toBeUndefined();
      expect(result.warnings[0]).toContain('not yet implemented');
    });

    it('handles image OCR returning empty text', async () => {
      const mockOcr: OcrAdapter = {
        recognize: vi.fn().mockResolvedValue({
          text: '',
          confidence: 0.1,
        } satisfies OcrResult),
      };

      const router = new MultimodalRouter({ ocrAdapter: mockOcr });
      const context = makeContext();
      const input: MultimodalCollectInput = {
        fileName: 'blank.png',
        mimeType: 'image/png',
        content: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077533de400000000049454e44ae426082', 'hex'),
      };

      const result = await router.route(input, context);

      expect(result.category).toBe('image');
      expect(result.extractedText).toBe('');
      expect(result.draft).toBeUndefined();
      expect(result.warnings[0]).toContain('no text');
    });
  });
});
