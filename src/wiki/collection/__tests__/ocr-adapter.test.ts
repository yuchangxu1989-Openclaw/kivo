/**
 * Tests for FR-A02 FR-A: OCR adapter extensions.
 *
 * Covers:
 * - validateOcrImage failure state machine
 * - LlmOcrAdapter / PaddleOcrAdapter producing textBlocks
 * - FormulaAwareOcrAdapter merging base OCR + formula detector results
 * - CompositeOcrAdapter falling back to enhanced channel on low confidence / failure
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CompositeOcrAdapter,
  FormulaAwareOcrAdapter,
  LlmOcrAdapter,
  ensureTextBlocks,
  legacyBlocksToTextBlocks,
  validateOcrImage,
  type OcrAdapter,
  type OcrResult,
} from '../ocr-adapter.js';

// Minimal valid PNG header (8 bytes signature) so validation passes.
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

describe('validateOcrImage', () => {
  it('returns image_empty for null / empty buffer', () => {
    expect(validateOcrImage(undefined)).toBe('image_empty');
    expect(validateOcrImage(Buffer.alloc(0))).toBe('image_empty');
  });

  it('returns image_unreadable for too-short / unknown header', () => {
    expect(validateOcrImage(Buffer.from([0x00, 0x01]))).toBe('image_unreadable');
    // ZIP magic is not an image header.
    expect(validateOcrImage(Buffer.from([0x50, 0x4B, 0x03, 0x04]))).toBe('image_unreadable');
  });

  it('accepts PNG / JPEG / GIF / WebP / BMP / TIFF', () => {
    expect(validateOcrImage(PNG_HEADER)).toBeNull();
    expect(validateOcrImage(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]))).toBeNull();
    expect(validateOcrImage(Buffer.from([0x47, 0x49, 0x46, 0x38]))).toBeNull();
    expect(validateOcrImage(Buffer.from([0x52, 0x49, 0x46, 0x46]))).toBeNull();
    expect(validateOcrImage(Buffer.from([0x42, 0x4D, 0x00, 0x00]))).toBeNull();
    expect(validateOcrImage(Buffer.from([0x49, 0x49, 0x2A, 0x00]))).toBeNull();
  });
});

describe('legacyBlocksToTextBlocks / ensureTextBlocks', () => {
  it('normalizes legacy blocks into textBlocks with bbox + type', () => {
    const blocks = legacyBlocksToTextBlocks([
      { text: 'hello', box: [[0, 0], [10, 10]], confidence: 0.9, kind: 'text' },
      { text: 'E=mc^2', box: [[20, 20], [40, 30]], confidence: 0.8, kind: 'formula' },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ text: 'hello', type: 'text', confidence: 0.9, source: 'primary' });
    expect(blocks[0].bbox).toEqual([[0, 0], [10, 10]]);
    expect(blocks[1]).toMatchObject({ type: 'formula' });
  });

  it('falls back to a single text block when only `text` is present', () => {
    const result: OcrResult = { text: 'plain', confidence: 0.7 };
    const ensured = ensureTextBlocks(result);
    expect(ensured.textBlocks).toHaveLength(1);
    expect(ensured.textBlocks?.[0]).toMatchObject({ text: 'plain', type: 'text', confidence: 0.7 });
  });
});

describe('LlmOcrAdapter', () => {
  it('returns text + textBlocks on success', async () => {
    const llm = { complete: vi.fn().mockResolvedValue('  Hello world  ') };
    const adapter = new LlmOcrAdapter({ llm, model: 'gpt-vision' });
    const result = await adapter.recognize(PNG_HEADER, { language: 'en' });
    expect(result.text).toBe('Hello world');
    expect(result.textBlocks).toHaveLength(1);
    expect(result.textBlocks?.[0]).toMatchObject({ text: 'Hello world', type: 'text', source: 'primary' });
    expect(result.failureReason).toBeUndefined();
  });

  it('marks ocr_engine_unavailable when LLM throws', async () => {
    const llm = { complete: vi.fn().mockRejectedValue(new Error('boom')) };
    const adapter = new LlmOcrAdapter({ llm, model: 'gpt-vision' });
    const result = await adapter.recognize(PNG_HEADER);
    expect(result.failureReason).toBe('ocr_engine_unavailable');
    expect(result.warnings?.[0]).toContain('boom');
  });
});

describe('FormulaAwareOcrAdapter', () => {
  it('merges base OCR text with formula regions', async () => {
    const base: OcrAdapter = {
      recognize: vi.fn().mockResolvedValue({
        text: 'In the equation, ',
        confidence: 0.85,
        textBlocks: [{ text: 'In the equation,', type: 'text', confidence: 0.85, source: 'primary' }],
      } satisfies OcrResult),
    };
    const llm = {
      complete: vi.fn().mockResolvedValue(JSON.stringify({
        formulas: [{ bbox: [[10, 20], [80, 50]], latex: 'E=mc^2' }],
        warnings: [],
      })),
    };
    const adapter = new FormulaAwareOcrAdapter({ base, llm, model: 'gpt-vision' });
    const result = await adapter.recognize(PNG_HEADER);

    expect(result.textBlocks).toHaveLength(2);
    const formula = result.textBlocks?.find((b) => b.type === 'formula');
    expect(formula).toBeDefined();
    expect(formula?.text).toBe('E=mc^2');
    expect(formula?.bbox).toEqual([[10, 20], [80, 50]]);
    expect(formula?.source).toBe('formula-detector');
    expect(result.text).toContain('E=mc^2');
  });

  it('tolerates formula detector failure and returns base result', async () => {
    const base: OcrAdapter = {
      recognize: vi.fn().mockResolvedValue({
        text: 'Just text.',
        confidence: 0.85,
        textBlocks: [{ text: 'Just text.', type: 'text', confidence: 0.85, source: 'primary' }],
      } satisfies OcrResult),
    };
    const llm = { complete: vi.fn().mockRejectedValue(new Error('detector down')) };
    const adapter = new FormulaAwareOcrAdapter({ base, llm, model: 'gpt-vision' });
    const result = await adapter.recognize(PNG_HEADER);

    expect(result.text).toBe('Just text.');
    expect(result.warnings?.some((w) => w.includes('Formula detector failed'))).toBe(true);
    expect(result.failureReason).toBeUndefined();
  });

  it('rejects empty / unreadable images before calling base or detector', async () => {
    const base: OcrAdapter = { recognize: vi.fn() };
    const llm = { complete: vi.fn() };
    const adapter = new FormulaAwareOcrAdapter({ base, llm, model: 'gpt-vision' });

    const result = await adapter.recognize(Buffer.alloc(0));
    expect(result.failureReason).toBe('image_empty');
    expect(base.recognize).not.toHaveBeenCalled();
    expect(llm.complete).not.toHaveBeenCalled();
  });
});

describe('CompositeOcrAdapter', () => {
  const goodPrimary: OcrAdapter = {
    recognize: vi.fn().mockResolvedValue({
      text: 'Crisp primary text',
      confidence: 0.9,
      textBlocks: [{ text: 'Crisp primary text', type: 'text', confidence: 0.9, source: 'primary' }],
    } satisfies OcrResult),
  };

  const lowConfPrimary: OcrAdapter = {
    recognize: vi.fn().mockResolvedValue({
      text: 'foggy',
      confidence: 0.3,
      textBlocks: [{ text: 'foggy', type: 'text', confidence: 0.3, source: 'primary' }],
    } satisfies OcrResult),
  };

  const failingPrimary: OcrAdapter = {
    recognize: vi.fn().mockResolvedValue({
      text: '',
      confidence: 0,
      failureReason: 'ocr_engine_unavailable',
    } satisfies OcrResult),
  };

  const enhanced: OcrAdapter = {
    recognize: vi.fn().mockResolvedValue({
      text: 'Enhanced channel resolved this',
      confidence: 0.95,
      textBlocks: [{ text: 'Enhanced channel resolved this', type: 'text', confidence: 0.95, source: 'enhanced' }],
    } satisfies OcrResult),
  };

  it('skips enhanced channel when primary is good enough', async () => {
    const adapter = new CompositeOcrAdapter({ primary: goodPrimary, enhanced });
    const result = await adapter.recognize(PNG_HEADER);
    expect(result.text).toBe('Crisp primary text');
    expect(enhanced.recognize).not.toHaveBeenCalled();
  });

  it('triggers enhanced channel on low confidence and merges blocks', async () => {
    vi.mocked(enhanced.recognize).mockClear();
    const adapter = new CompositeOcrAdapter({ primary: lowConfPrimary, enhanced, lowConfidenceThreshold: 0.6 });
    const result = await adapter.recognize(PNG_HEADER);
    expect(enhanced.recognize).toHaveBeenCalledOnce();
    expect(result.textBlocks?.some((b) => b.source === 'enhanced')).toBe(true);
    expect(result.text).toContain('Enhanced channel resolved this');
  });

  it('falls back to enhanced channel when primary fails', async () => {
    vi.mocked(enhanced.recognize).mockClear();
    const adapter = new CompositeOcrAdapter({ primary: failingPrimary, enhanced });
    const result = await adapter.recognize(PNG_HEADER);
    expect(enhanced.recognize).toHaveBeenCalledOnce();
    expect(result.text).toBe('Enhanced channel resolved this');
    expect(result.textBlocks?.[0]?.source).toBe('enhanced');
    expect(result.warnings?.some((w) => w.includes('fell back to enhanced channel'))).toBe(true);
  });

  it('records ocr_low_confidence when both channels yield no text', async () => {
    const emptyPrimary: OcrAdapter = {
      recognize: vi.fn().mockResolvedValue({ text: '', confidence: 0.1 } satisfies OcrResult),
    };
    const emptyEnhanced: OcrAdapter = {
      recognize: vi.fn().mockResolvedValue({ text: '', confidence: 0 } satisfies OcrResult),
    };
    const adapter = new CompositeOcrAdapter({ primary: emptyPrimary, enhanced: emptyEnhanced });
    const result = await adapter.recognize(PNG_HEADER);
    expect(result.text).toBe('');
    expect(result.failureReason).toBeDefined();
  });
});
