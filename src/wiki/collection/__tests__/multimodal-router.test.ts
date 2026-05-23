/**
 * Tests for MultimodalRouter: MIME categorization and routing logic.
 */

import { describe, it, expect, vi } from 'vitest';
import { MultimodalRouter } from '../multimodal-router.js';
import type { CollectorContext, MultimodalCollectInput } from '../../types.js';
import type { OcrAdapter, OcrResult } from '../ocr-adapter.js';

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

    it('gracefully degrades for audio when whisper is unavailable', async () => {
      const router = new MultimodalRouter();
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
        content: new Uint8Array([0x89, 0x50]),
      };

      const result = await router.route(input, context);

      expect(result.category).toBe('image');
      expect(result.extractedText).toBe('');
      expect(result.draft).toBeUndefined();
      expect(result.warnings[0]).toContain('no text');
    });
  });
});
