/**
 * FR-1 AC-1.2, NFR-1
 * OCR adapter: extract text from images via LLM vision API.
 */

import type { LLMAdapter } from '../types.js';

export interface OcrOptions {
  language?: string;
  signal?: AbortSignal;
}

export interface OcrResult {
  text: string;
  confidence: number;
  language?: string;
  warnings?: string[];
}

export interface OcrAdapter {
  recognize(imageBuffer: Buffer, options?: OcrOptions): Promise<OcrResult>;
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

      return {
        text: text.trim(),
        confidence: 0.85,
        language: options?.language,
      };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        text: '',
        confidence: 0,
        language: 'unknown',
        warnings: [`LLM vision OCR failed: ${reason}`],
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
