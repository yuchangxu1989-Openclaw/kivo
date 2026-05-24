/**
 * FR-1 AC-1.2, NFR-1
 * FR-A02 FR-A AC1..AC5
 * OCR adapter: extract text from images. Default channel is LLM vision; PaddleOCR
 * adapter exists for offline / privacy-preserving runs; FormulaAwareOcrAdapter
 * adds formula-region → LaTeX detection on top of any base OCR; CompositeOcrAdapter
 * gates a paid enhanced channel as a fallback for low-confidence regions.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { LLMAdapter } from '../types.js';

const execFileAsync = promisify(execFile);

export interface OcrOptions {
  language?: string;
  signal?: AbortSignal;
  /** Optional caller-supplied identifier (page id / image id) carried into textBlocks. */
  imageId?: string;
}

export interface OcrBlock {
  text: string;
  box?: number[][];
  confidence?: number;
  kind?: 'text' | 'formula';
}

/**
 * FR-A02 FR-A AC1/AC2/AC4 - rich block schema with bbox, type and confidence.
 * `bbox` matches PaddleOCR / LLM Vision convention: [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
 * (clockwise quadrilateral) or [[x1,y1],[x2,y2]] (axis-aligned rectangle, top-left + bottom-right).
 */
export interface OcrTextBlock {
  text: string;
  bbox?: number[][];
  type: 'text' | 'formula' | 'mixed';
  confidence: number;
  /** Which channel produced this block: primary OCR, enhanced OCR or formula detector. */
  source?: 'primary' | 'enhanced' | 'formula-detector';
  /** Optional caller-supplied image / page id, useful when the same buffer is one page among many. */
  imageId?: string;
}

/**
 * FR-A02 FR-A AC5 - explicit failure state machine. Anything that is not a
 * silent-success path lands in one of these reasons so downstream UI can show
 * a readable status instead of leaving the material stuck on "解析中".
 */
export type OcrFailureReason =
  | 'image_unreadable'
  | 'image_empty'
  | 'ocr_engine_unavailable'
  | 'ocr_low_confidence';

export interface OcrResult {
  text: string;
  confidence: number;
  language?: string;
  warnings?: string[];
  blocks?: OcrBlock[];
  /** FR-A02 FR-A AC1/AC2/AC4 preferred output: structured blocks with bbox + type. */
  textBlocks?: OcrTextBlock[];
  /** FR-A02 FR-A AC5 explicit failure reason. Empty/undefined means success. */
  failureReason?: OcrFailureReason;
}

export interface OcrAdapter {
  recognize(imageBuffer: Buffer, options?: OcrOptions): Promise<OcrResult>;
}

/**
 * FR-A02 FR-A AC5 pre-OCR validation. Catches the cheapest failure modes
 * (empty buffer, header bytes don't match any known image format) without
 * spending an LLM/PaddleOCR call.
 */
export function validateOcrImage(buffer: Buffer | Uint8Array | undefined | null): OcrFailureReason | null {
  if (!buffer || buffer.byteLength === 0) return 'image_empty';
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (b.byteLength < 4) return 'image_unreadable';
  const h = b;
  // JPEG
  if (h[0] === 0xFF && h[1] === 0xD8) return null;
  // PNG (89 50 4E 47)
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47) return null;
  // GIF (47 49 46)
  if (h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46) return null;
  // WebP / RIFF (52 49 46 46)
  if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46) return null;
  // BMP (42 4D)
  if (h[0] === 0x42 && h[1] === 0x4D) return null;
  // TIFF (49 49 2A 00 / 4D 4D 00 2A)
  if (h[0] === 0x49 && h[1] === 0x49 && h[2] === 0x2A) return null;
  if (h[0] === 0x4D && h[1] === 0x4D && h[2] === 0x00 && h[3] === 0x2A) return null;
  return 'image_unreadable';
}

/**
 * Convert legacy `OcrBlock` (PaddleOCR-style) into rich `OcrTextBlock`.
 * Used to keep backwards compatibility for adapters that still emit `blocks`.
 */
export function legacyBlocksToTextBlocks(
  blocks: OcrBlock[] | undefined,
  source: 'primary' | 'enhanced' | 'formula-detector' = 'primary',
  imageId?: string,
): OcrTextBlock[] {
  if (!blocks?.length) return [];
  return blocks.map((b) => ({
    text: b.text,
    bbox: b.box,
    type: (b.kind === 'formula' ? 'formula' : 'text') as 'text' | 'formula',
    confidence: typeof b.confidence === 'number' ? b.confidence : 0.6,
    source,
    imageId,
  }));
}

/**
 * Coalesce raw OCR result into an OcrResult that always carries `textBlocks`
 * (the FR-A02 preferred shape) regardless of which legacy fields the adapter set.
 */
export function ensureTextBlocks(result: OcrResult, options?: { source?: 'primary' | 'enhanced' | 'formula-detector'; imageId?: string }): OcrResult {
  if (result.textBlocks?.length) return result;
  if (result.blocks?.length) {
    return { ...result, textBlocks: legacyBlocksToTextBlocks(result.blocks, options?.source ?? 'primary', options?.imageId) };
  }
  if (result.text.trim()) {
    return {
      ...result,
      textBlocks: [{
        text: result.text,
        type: 'text',
        confidence: result.confidence,
        source: options?.source ?? 'primary',
        imageId: options?.imageId,
      }],
    };
  }
  return result;
}

export interface LlmOcrAdapterConfig {
  llm: LLMAdapter;
  model: string;
}

/**
 * Default OCR implementation using LLM vision capabilities.
 * Sends the image as base64 to the LLM with an OCR prompt.
 */
export class LlmOcrAdapter implements OcrAdapter {
  private readonly llm: LLMAdapter;
  private readonly model: string;

  constructor(config: LlmOcrAdapterConfig) {
    this.llm = config.llm;
    this.model = config.model;
  }

  async recognize(imageBuffer: Buffer, options?: OcrOptions): Promise<OcrResult> {
    const base64 = imageBuffer.toString('base64');
    const mimeType = detectImageMime(imageBuffer);
    const dataUri = `data:${mimeType};base64,${base64}`;

    const languageHint = options?.language ? ` The text is primarily in ${options.language}.` : '';
    const prompt = [
      'You are an OCR engine. Extract ALL text visible in this image.',
      'Return ONLY the extracted text, preserving layout and line breaks where possible.',
      'Do not add commentary, explanations, or formatting beyond what is in the image.',
      languageHint,
    ].filter(Boolean).join('\n');

    try {
      const text = await this.llm.complete({
        model: this.model,
        prompt,
        content: dataUri,
        signal: options?.signal,
      });

      const trimmed = text.trim();
      const textBlocks: OcrTextBlock[] = trimmed
        ? [{ text: trimmed, type: 'text', confidence: 0.85, source: 'primary', imageId: options?.imageId }]
        : [];
      return {
        text: trimmed,
        confidence: 0.85,
        language: options?.language,
        textBlocks,
      };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        text: '',
        confidence: 0,
        language: 'unknown',
        warnings: [`LLM vision OCR failed: ${reason}`],
        failureReason: 'ocr_engine_unavailable',
      };
    }
  }
}

function detectImageMime(buffer: Buffer): string {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  return 'image/png';
}


/**
 * Local PaddleOCR implementation. It is the default image OCR path for KIVO uploads.
 * The command is intentionally explicit: when PaddleOCR is unavailable, callers get
 * a user-readable installation hint instead of a silent empty OCR result.
 */
export class PaddleOcrAdapter implements OcrAdapter {
  async recognize(imageBuffer: Buffer, options?: OcrOptions): Promise<OcrResult> {
    const tempDir = await mkdtemp(join(tmpdir(), 'kivo-paddleocr-'));
    const inputFile = join(tempDir, `${randomUUID()}.${extensionForImage(imageBuffer)}`);
    const outputDir = join(tempDir, 'out');

    try {
      await writeFile(inputFile, imageBuffer);
      await execFileAsync('paddleocr', [
        '--image_dir', inputFile,
        '--use_angle_cls', 'true',
        '--lang', paddleLanguage(options?.language),
        '--output', outputDir,
      ], { timeout: 300_000 });

      const resultFile = join(outputDir, 'inference_results.txt');
      const raw = await readFile(resultFile, 'utf-8').catch(() => '');
      const parsed = parsePaddleOcrOutput(raw);

      const textBlocks = legacyBlocksToTextBlocks(parsed.blocks, 'primary', options?.imageId);
      return {
        text: parsed.text,
        confidence: parsed.confidence,
        language: options?.language ?? 'zh',
        blocks: parsed.blocks,
        textBlocks,
        warnings: parsed.text.trim() ? [] : ['PaddleOCR finished but produced no text.'],
      };
    } catch (error: unknown) {
      if (isCommandNotFound(error)) {
        throw new Error('PaddleOCR command not found. Install PaddleOCR locally, for example: python3 -m pip install paddlepaddle paddleocr, and ensure `paddleocr` is on PATH.');
      }
      throw error;
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * FR-A02 FR-A AC2 - formula-aware OCR. Wraps any base OCR adapter and adds an
 * LLM-Vision formula detection pass. Formula regions are returned as `type: 'formula'`
 * with `text` carrying the LaTeX rendering; non-formula regions are inherited from
 * the base adapter as `type: 'text'`. Both kinds are addressable via `bbox` so the
 * downstream knowledge layer can link a knowledge entry back to the source region.
 */
export interface FormulaAwareOcrAdapterConfig {
  base: OcrAdapter;
  llm: LLMAdapter;
  /** Vision-capable model id (must accept image data URIs in `content`). */
  model: string;
  /** When true (default), failures inside the formula detector degrade gracefully
   *  to base OCR result with a warning, instead of failing the whole image.
   */
  tolerateDetectorFailure?: boolean;
}

interface FormulaDetectorRegion {
  bbox?: number[][];
  latex: string;
}

export class FormulaAwareOcrAdapter implements OcrAdapter {
  private readonly base: OcrAdapter;
  private readonly llm: LLMAdapter;
  private readonly model: string;
  private readonly tolerateDetectorFailure: boolean;

  constructor(config: FormulaAwareOcrAdapterConfig) {
    this.base = config.base;
    this.llm = config.llm;
    this.model = config.model;
    this.tolerateDetectorFailure = config.tolerateDetectorFailure ?? true;
  }

  async recognize(imageBuffer: Buffer, options?: OcrOptions): Promise<OcrResult> {
    const empty = validateOcrImage(imageBuffer);
    if (empty) {
      return {
        text: '',
        confidence: 0,
        textBlocks: [],
        failureReason: empty,
        warnings: [`Formula-aware OCR rejected image: ${empty}`],
      };
    }

    const baseResult = await this.base.recognize(imageBuffer, options);
    const normalizedBase = ensureTextBlocks(baseResult, { source: 'primary', imageId: options?.imageId });
    const baseBlocks = normalizedBase.textBlocks ?? [];

    if (baseBlocks.length === 0) {
      return normalizedBase;
    }
    if (baseBlocks.length === 1 && baseBlocks[0].text.trim() === normalizedBase.text.trim() && !baseResult.textBlocks?.length && !baseResult.blocks?.length) {
      return normalizedBase;
    }

    const formulaResult = await this.detectFormulas(imageBuffer, options);

    if (baseResult.failureReason && formulaResult.regions.length === 0) {
      // Base failed and we have no formulas to salvage anything with.
      return normalizedBase;
    }

    const formulaBlocks: OcrTextBlock[] = formulaResult.regions.map((region) => ({
      text: region.latex,
      bbox: region.bbox,
      type: 'formula' as const,
      confidence: 0.9,
      source: 'formula-detector' as const,
      imageId: options?.imageId,
    }));

    const merged = [...baseBlocks, ...formulaBlocks];
    const text = merged.map((b) => b.text).filter(Boolean).join('\n').trim();
    const warnings = [...(baseResult.warnings ?? []), ...(formulaResult.warnings ?? [])];

    return {
      text,
      confidence: baseResult.confidence,
      language: baseResult.language,
      textBlocks: merged,
      blocks: baseResult.blocks,
      warnings,
      failureReason: text.trim() ? undefined : (baseResult.failureReason ?? 'image_empty'),
    };
  }

  private async detectFormulas(
    imageBuffer: Buffer,
    options?: OcrOptions,
  ): Promise<{ regions: FormulaDetectorRegion[]; warnings: string[] }> {
    const dataUri = `data:${detectImageMime(imageBuffer)};base64,${imageBuffer.toString('base64')}`;
    const prompt = [
      'You are a math formula detector for OCR pipelines.',
      'Look at the image and find any rendered mathematical formulas (inline or display style).',
      'Return STRICT minified JSON with this schema and nothing else:',
      '{"formulas":[{"bbox":[[x1,y1],[x2,y2]],"latex":"<LaTeX>"}],"warnings":[]}',
      'If there are no formulas, return {"formulas":[],"warnings":[]}.',
      'Coordinates are pixels with origin at top-left; bbox uses two opposite corners.',
    ].join('\n');

    try {
      const raw = await this.llm.complete({
        model: this.model,
        prompt,
        content: dataUri,
        signal: options?.signal,
      });
      const parsed = parseFormulaDetectorResponse(raw);
      return parsed;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!this.tolerateDetectorFailure) throw error;
      return { regions: [], warnings: [`Formula detector failed: ${reason}`] };
    }
  }
}

function parseFormulaDetectorResponse(raw: string): { regions: FormulaDetectorRegion[]; warnings: string[] } {
  const trimmed = raw.trim();
  if (!trimmed) return { regions: [], warnings: [] };
  // Try to find a JSON object inside the response (LLMs sometimes wrap output in ```json fences).
  const jsonMatch = trimmed.match(/\{[\s\S]*\}$/m) ?? trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { regions: [], warnings: ['Formula detector returned non-JSON response'] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { regions: [], warnings: ['Formula detector returned malformed JSON'] };
  }
  if (!parsed || typeof parsed !== 'object') return { regions: [], warnings: [] };
  const obj = parsed as { formulas?: unknown; warnings?: unknown };
  const regions: FormulaDetectorRegion[] = [];
  if (Array.isArray(obj.formulas)) {
    for (const item of obj.formulas) {
      if (!item || typeof item !== 'object') continue;
      const f = item as { bbox?: unknown; latex?: unknown };
      const latex = typeof f.latex === 'string' ? f.latex.trim() : '';
      if (!latex) continue;
      const bbox = Array.isArray(f.bbox) ? (f.bbox as number[][]) : undefined;
      regions.push({ latex, bbox });
    }
  }
  const warnings = Array.isArray(obj.warnings)
    ? (obj.warnings as unknown[]).filter((w): w is string => typeof w === 'string')
    : [];
  return { regions, warnings };
}

/**
 * FR-A02 FR-A AC3 - composite OCR with optional enhanced channel. The primary
 * adapter runs first; if its result has empty text, an explicit failure reason,
 * or confidence below `lowConfidenceThreshold`, the enhanced adapter is invoked
 * and merged in. Enhanced blocks are tagged `source: 'enhanced'` so callers can
 * tell which channel each block came from.
 */
export interface CompositeOcrAdapterConfig {
  primary: OcrAdapter;
  enhanced: OcrAdapter;
  /** Confidence threshold; results <= this trigger the enhanced channel. Default 0.6. */
  lowConfidenceThreshold?: number;
}

export class CompositeOcrAdapter implements OcrAdapter {
  private readonly primary: OcrAdapter;
  private readonly enhanced: OcrAdapter;
  private readonly lowConfidenceThreshold: number;

  constructor(config: CompositeOcrAdapterConfig) {
    this.primary = config.primary;
    this.enhanced = config.enhanced;
    this.lowConfidenceThreshold = config.lowConfidenceThreshold ?? 0.6;
  }

  async recognize(imageBuffer: Buffer, options?: OcrOptions): Promise<OcrResult> {
    const empty = validateOcrImage(imageBuffer);
    if (empty) {
      return {
        text: '',
        confidence: 0,
        textBlocks: [],
        failureReason: empty,
        warnings: [`Composite OCR rejected image: ${empty}`],
      };
    }

    let primary: OcrResult;
    try {
      primary = await this.primary.recognize(imageBuffer, options);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      primary = {
        text: '',
        confidence: 0,
        warnings: [`Primary OCR failed: ${reason}`],
        failureReason: 'ocr_engine_unavailable',
      };
    }

    const needsEnhanced = !primary.text.trim()
      || primary.failureReason !== undefined
      || primary.confidence <= this.lowConfidenceThreshold;

    if (!needsEnhanced) {
      return ensureTextBlocks(primary, { source: 'primary', imageId: options?.imageId });
    }

    let enhanced: OcrResult;
    try {
      enhanced = await this.enhanced.recognize(imageBuffer, options);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      const merged = ensureTextBlocks(primary, { source: 'primary', imageId: options?.imageId });
      return {
        ...merged,
        warnings: [...(merged.warnings ?? []), `Enhanced OCR fallback failed: ${reason}`],
        failureReason: merged.failureReason ?? (merged.text.trim() ? 'ocr_low_confidence' : 'ocr_engine_unavailable'),
      };
    }

    const primaryBlocks = ensureTextBlocks(primary, { source: 'primary', imageId: options?.imageId }).textBlocks ?? [];
    const enhancedBlocks = (ensureTextBlocks(enhanced, { source: 'enhanced', imageId: options?.imageId }).textBlocks ?? [])
      .map((b) => ({ ...b, source: 'enhanced' as const }));

    // Prefer enhanced text when primary was empty / failed; otherwise concatenate both for traceability.
    const useEnhancedOnly = !primary.text.trim() || primary.failureReason !== undefined;
    const merged = useEnhancedOnly ? enhancedBlocks : [...primaryBlocks, ...enhancedBlocks];
    const text = merged.map((b) => b.text).filter(Boolean).join('\n').trim();
    const warnings = [...(primary.warnings ?? []), ...(enhanced.warnings ?? [])];
    if (useEnhancedOnly && primary.failureReason) {
      warnings.unshift(`Primary OCR fell back to enhanced channel: ${primary.failureReason}`);
    }
    const confidence = useEnhancedOnly ? enhanced.confidence : Math.max(primary.confidence, enhanced.confidence);
    const failureReason = text.trim()
      ? undefined
      : (enhanced.failureReason ?? primary.failureReason ?? 'ocr_engine_unavailable');

    return {
      text,
      confidence,
      language: primary.language ?? enhanced.language,
      textBlocks: merged,
      warnings,
      failureReason,
    };
  }
}

function isCommandNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}

function extensionForImage(buffer: Buffer): string {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'jpg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'webp';
  return 'png';
}

function paddleLanguage(language?: string): string {
  const normalized = (language ?? 'zh').toLowerCase();
  if (normalized.startsWith('en')) return 'en';
  return 'ch';
}

function parsePaddleOcrOutput(raw: string): { text: string; confidence: number; blocks: OcrBlock[] } {
  const blocks: OcrBlock[] = [];
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const parsed = parsePaddleLine(line);
    if (parsed && parsed.text.trim()) blocks.push(parsed);
  }

  if (blocks.length === 0 && raw.trim()) {
    blocks.push({ text: raw.trim(), confidence: 0.6, kind: 'text' });
  }

  const text = blocks.map((block) => block.text).join('\n').trim();
  const confidences = blocks.map((block) => block.confidence).filter((value): value is number => typeof value === 'number');
  const confidence = confidences.length > 0
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : (text ? 0.6 : 0);

  return { text, confidence, blocks };
}

function parsePaddleLine(line: string): OcrBlock | null {
  try {
    const jsonPart = line.includes('\t') ? line.slice(line.indexOf('\t') + 1) : line;
    const parsed = JSON.parse(jsonPart) as unknown;
    if (Array.isArray(parsed)) {
      return parsePaddleArray(parsed);
    }
  } catch {
    // Fall through to plain text handling.
  }

  const stripped = line.replace(/^\S+\t/, '').trim();
  return stripped ? { text: stripped, confidence: 0.6, kind: 'text' } : null;
}

function parsePaddleArray(parsed: unknown[]): OcrBlock | null {
  if (parsed.length >= 2 && typeof parsed[1] === 'string') {
    return {
      box: Array.isArray(parsed[0]) ? parsed[0] as number[][] : undefined,
      text: parsed[1],
      confidence: typeof parsed[2] === 'number' ? parsed[2] : 0.6,
      kind: 'text',
    };
  }

  if (parsed.length >= 2 && Array.isArray(parsed[1])) {
    const second = parsed[1] as unknown[];
    const text = typeof second[0] === 'string' ? second[0] : '';
    return text ? {
      box: Array.isArray(parsed[0]) ? parsed[0] as number[][] : undefined,
      text,
      confidence: typeof second[1] === 'number' ? second[1] : 0.6,
      kind: 'text',
    } : null;
  }

  return null;
}
