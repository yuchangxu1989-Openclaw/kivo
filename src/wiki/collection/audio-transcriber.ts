/**
 * FR-A02 FR-B
 * Audio transcription adapter: converts audio buffers to timestamped text fragments via local Whisper CLI.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { basename, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { TranscribeOptions, TranscribeResult } from '../types.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_WHISPER_LANGUAGE = 'zh';
export const DEFAULT_WHISPER_MODEL: WhisperModel = 'tiny';
export const ALLOWED_WHISPER_MODELS = ['tiny', 'base'] as const;

export const DEFAULT_AUDIO_LIMITS = {
  maxFileSizeBytes: 50 * 1024 * 1024,
  maxSegmentDurationSeconds: 30 * 60,
} as const;

export type WhisperModel = (typeof ALLOWED_WHISPER_MODELS)[number];
export type AudioTranscriptionErrorCode = 'audio_too_long' | 'audio_oversized' | 'whisper_unavailable' | 'transcription_failed';

export class AudioTranscriptionError extends Error {
  constructor(
    public readonly code: AudioTranscriptionErrorCode,
    message: string,
    public readonly originalAudioPath?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AudioTranscriptionError';
  }
}

export interface AudioTranscriber {
  transcribe(audioBuffer: Buffer, options?: TranscribeOptions): Promise<TranscribeResult>;
}

interface WhisperSegment {
  id?: number;
  seek?: number;
  start: number;
  end: number;
  text: string;
}

interface WhisperOutput {
  text?: string;
  language?: string;
  segments?: WhisperSegment[];
}

export class WhisperTranscriber implements AudioTranscriber {
  async transcribe(audioBuffer: Buffer, options?: TranscribeOptions): Promise<TranscribeResult> {
    const language = normalizeLanguage(options?.language);
    const model = normalizeModel(options?.model);
    const limits = {
      maxFileSizeBytes: options?.maxFileSizeBytes ?? DEFAULT_AUDIO_LIMITS.maxFileSizeBytes,
      maxSegmentDurationSeconds: options?.maxSegmentDurationSeconds ?? DEFAULT_AUDIO_LIMITS.maxSegmentDurationSeconds,
    };

    if (audioBuffer.byteLength > limits.maxFileSizeBytes) {
      throw new AudioTranscriptionError(
        'audio_oversized',
        `音频文件过大：${formatBytes(audioBuffer.byteLength)}，上限 ${formatBytes(limits.maxFileSizeBytes)}。请压缩或拆分后重试。`,
        options?.sourceMediaPath,
      );
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'kivo-whisper-'));
    const inputFile = join(tempDir, `${randomUUID()}.wav`);

    try {
      await writeFile(inputFile, audioBuffer);

      await execFileAsync('whisper', [
        inputFile,
        '--language', language,
        '--model', model,
        '--output_format', 'json',
        '--output_dir', tempDir,
      ], {
        timeout: 600_000,
      });

      const jsonPath = join(tempDir, `${parse(basename(inputFile)).name}.json`);
      const raw = await readFile(jsonPath, 'utf-8');
      const output = parseWhisperOutput(raw, language);
      const segments = normalizeSegments(output.segments ?? [], limits.maxSegmentDurationSeconds, options?.sourceMediaPath);
      const text = (output.text ?? segments.map((segment) => segment.text).join('').trim()).trim();
      const durationSeconds = segments.length > 0 ? segments[segments.length - 1].end : 0;

      const result: TranscribeResult = {
        text,
        language: output.language ?? language,
        durationSeconds,
      };

      if (options?.includeSegments !== false && segments.length > 0) {
        result.segments = segments;
      }

      return result;
    } catch (error: unknown) {
      if (error instanceof AudioTranscriptionError) throw error;
      if (isCommandNotFound(error)) {
        throw new AudioTranscriptionError(
          'whisper_unavailable',
          '本地 Whisper 不可用：未找到 whisper 命令。请先安装 openai-whisper，或换通道重试。',
          options?.sourceMediaPath,
          error,
        );
      }
      throw new AudioTranscriptionError(
        'transcription_failed',
        `音频转写失败：${error instanceof Error ? error.message : String(error)}`,
        options?.sourceMediaPath,
        error,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function normalizeModel(model?: TranscribeOptions['model']): WhisperModel {
  if (!model) return DEFAULT_WHISPER_MODEL;
  if (ALLOWED_WHISPER_MODELS.includes(model)) return model;
  throw new AudioTranscriptionError(
    'transcription_failed',
    `不支持的 Whisper 模型：${String(model)}。本机只允许 tiny/base，避免无 GPU 环境 OOM。`,
  );
}

export function normalizeSegments(
  segments: WhisperSegment[],
  maxSegmentDurationSeconds = DEFAULT_AUDIO_LIMITS.maxSegmentDurationSeconds,
  originalAudioPath?: string,
): Array<{ start: number; end: number; text: string }> {
  return segments
    .map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
      text: (segment.text ?? '').trim(),
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.text.length > 0)
    .map((segment) => {
      if (segment.end < segment.start) {
        throw new AudioTranscriptionError('transcription_failed', 'Whisper 返回了无效时间戳：片段结束时间早于开始时间。', originalAudioPath);
      }
      if (segment.end - segment.start > maxSegmentDurationSeconds) {
        throw new AudioTranscriptionError(
          'audio_too_long',
          `音频片段过长：${Math.round(segment.end - segment.start)} 秒，上限 ${maxSegmentDurationSeconds} 秒。请拆分后重试。`,
          originalAudioPath,
        );
      }
      return segment;
    });
}

function normalizeLanguage(language?: string): string {
  return language?.trim() || DEFAULT_WHISPER_LANGUAGE;
}

function parseWhisperOutput(raw: string, fallbackLanguage: string): Required<WhisperOutput> {
  try {
    const parsed = JSON.parse(raw) as WhisperOutput;
    return {
      text: parsed.text ?? '',
      language: parsed.language ?? fallbackLanguage,
      segments: Array.isArray(parsed.segments) ? parsed.segments : [],
    };
  } catch (error: unknown) {
    throw new AudioTranscriptionError(
      'transcription_failed',
      `Whisper JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      undefined,
      error,
    );
  }
}

function isCommandNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

/** Singleton default transcriber instance. */
export const defaultTranscriber: AudioTranscriber = new WhisperTranscriber();
