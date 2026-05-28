/**
 * FR-A02 FR-A AC3 - default enhanced OCR channel adapter.
 *
 * This is a thin HTTP adapter that talks to an OpenAI-compatible vision endpoint
 * (the same shape as `https://api.penguinsaichat.dpdns.org/v1/chat/completions`,
 * Azure OpenAI, or any provider exposing the OpenAI vision contract). It is the
 * default backend for the "enhanced" channel because most paid OCR vendors today
 * either ship an OpenAI-compatible facade or are trivially adaptable to one.
 *
 * Operators who prefer a different vendor (Google Document AI, Azure Vision,
 * Tencent OCR, etc.) can swap in their own `OcrAdapter` without touching the
 * rest of the pipeline; this file only encodes the default mapping when the
 * config block sets a generic `provider` such as "openai-vision" or "penguin-vision".
 */

import type { OcrAdapter, OcrOptions, OcrResult, OcrTextBlock } from './ocr-adapter.js';
import { validateOcrImage } from './ocr-adapter.js';

export interface VisionEnhancedOcrAdapterConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  /** Allow callers to inject a fetch implementation (test mocks). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Defaults to 60s. */
  timeoutMs?: number;
}

interface OpenAiChatChoice {
  message?: { content?: string };
}

interface OpenAiChatResponse {
  choices?: OpenAiChatChoice[];
  error?: { message?: string };
}

const OCR_PROMPT = [
  'You are a high-accuracy OCR engine acting as the enhanced fallback channel.',
  'Extract ALL text visible in the image, preserving layout cues and line breaks.',
  'When you can identify rectangular regions, return STRICT minified JSON of the form:',
  '{"text":"<full text>","blocks":[{"text":"...","bbox":[[x1,y1],[x2,y2]],"type":"text"|"formula","confidence":0.0}]}',
  'Coordinates are pixel space, top-left origin.',
  'If you cannot localize blocks, return {"text":"<full text>","blocks":[]}.',
  'Do NOT add commentary outside the JSON.',
].join('\n');

export class VisionEnhancedOcrAdapter implements OcrAdapter {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: VisionEnhancedOcrAdapterConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async recognize(imageBuffer: Buffer, options?: OcrOptions): Promise<OcrResult> {
    const empty = validateOcrImage(imageBuffer);
    if (empty) {
      return {
        text: '',
        confidence: 0,
        textBlocks: [],
        failureReason: empty,
        warnings: [`Enhanced OCR rejected image: ${empty}`],
      };
    }

    const dataUri = `data:${detectMime(imageBuffer)};base64,${imageBuffer.toString('base64')}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = this.endpoint.endsWith('/chat/completions')
        ? this.endpoint
        : `${this.endpoint}/chat/completions`;
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: OCR_PROMPT },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          }],
          temperature: 0,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return {
          text: '',
          confidence: 0,
          warnings: [`Enhanced OCR HTTP ${response.status}: ${body.slice(0, 200)}`],
          failureReason: 'ocr_engine_unavailable',
        };
      }

      const json = (await response.json()) as OpenAiChatResponse;
      if (json.error?.message) {
        return {
          text: '',
          confidence: 0,
          warnings: [`Enhanced OCR error: ${json.error.message}`],
          failureReason: 'ocr_engine_unavailable',
        };
      }
      const raw = json.choices?.[0]?.message?.content?.trim() ?? '';
      return parseEnhancedOcrResponse(raw, options?.imageId);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        text: '',
        confidence: 0,
        warnings: [`Enhanced OCR call failed: ${reason}`],
        failureReason: 'ocr_engine_unavailable',
      };
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function parseEnhancedOcrResponse(raw: string, imageId?: string): OcrResult {
  if (!raw) return { text: '', confidence: 0, textBlocks: [], failureReason: 'ocr_low_confidence' };

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      text: raw,
      confidence: 0.6,
      textBlocks: [{ text: raw, type: 'text', confidence: 0.6, source: 'enhanced', imageId }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return {
      text: raw,
      confidence: 0.5,
      textBlocks: [{ text: raw, type: 'text', confidence: 0.5, source: 'enhanced', imageId }],
      warnings: ['Enhanced OCR returned non-JSON content; treated as plain text.'],
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { text: '', confidence: 0, textBlocks: [], failureReason: 'ocr_low_confidence' };
  }

  const obj = parsed as { text?: unknown; blocks?: unknown };
  const text = typeof obj.text === 'string' ? obj.text : '';
  const blocks: OcrTextBlock[] = [];
  if (Array.isArray(obj.blocks)) {
    for (const item of obj.blocks) {
      if (!item || typeof item !== 'object') continue;
      const b = item as { text?: unknown; bbox?: unknown; type?: unknown; confidence?: unknown };
      const blockText = typeof b.text === 'string' ? b.text : '';
      if (!blockText) continue;
      const type = (b.type === 'formula' || b.type === 'mixed') ? b.type : 'text';
      const confidence = typeof b.confidence === 'number' ? b.confidence : 0.7;
      const bbox = Array.isArray(b.bbox) ? (b.bbox as number[][]) : undefined;
      blocks.push({ text: blockText, bbox, type, confidence, source: 'enhanced', imageId });
    }
  }

  if (blocks.length === 0 && text.trim()) {
    blocks.push({ text, type: 'text', confidence: 0.7, source: 'enhanced', imageId });
  }

  return {
    text: text.trim(),
    confidence: blocks.length ? blocks.reduce((s, b) => s + b.confidence, 0) / blocks.length : 0,
    textBlocks: blocks,
    failureReason: !text.trim() ? 'ocr_low_confidence' : undefined,
  };
}

function detectMime(buffer: Buffer): string {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  return 'image/png';
}
