/**
 * FR-1 AC-1.2 Phase 2
 * Audio transcription adapter: converts audio buffers to text via local Whisper CLI.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { TranscribeOptions, TranscribeResult } from '../types.js';

const execFileAsync = promisify(execFile);

export interface AudioTranscriber {
  transcribe(audioBuffer: Buffer, options?: TranscribeOptions): Promise<TranscribeResult>;
}

interface WhisperSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
}

interface WhisperOutput {
  text: string;
  language: string;
  segments: WhisperSegment[];
}

export class WhisperTranscriber implements AudioTranscriber {
  async transcribe(audioBuffer: Buffer, options?: TranscribeOptions): Promise<TranscribeResult> {
    const language = options?.language ?? 'zh';
    const model = options?.model ?? 'base';

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
        timeout: 600_000, // 10 minutes max
      });

      // Whisper outputs <filename_without_ext>.json in the output dir
      const baseName = inputFile.replace(/\.[^.]+$/, '');
      const jsonPath = `${baseName}.json`;
      const raw = await readFile(jsonPath, 'utf-8');
      const output: WhisperOutput = JSON.parse(raw);

      const durationSeconds = output.segments.length > 0
        ? output.segments[output.segments.length - 1].end
        : 0;

      const result: TranscribeResult = {
        text: output.text.trim(),
        language: output.language ?? language,
        durationSeconds,
      };

      if (options?.includeSegments !== false && output.segments.length > 0) {
        result.segments = output.segments.map((seg) => ({
          start: seg.start,
          end: seg.end,
          text: seg.text.trim(),
        }));
      }

      return result;
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'ENOENT') {
        throw new Error('whisper command not found. Please install OpenAI Whisper: pip install openai-whisper');
      }
      throw error;
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Singleton default transcriber instance. */
export const defaultTranscriber: AudioTranscriber = new WhisperTranscriber();
