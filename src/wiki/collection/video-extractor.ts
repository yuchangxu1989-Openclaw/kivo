/**
 * FR-1 AC-1.2 Phase 2
 * Video audio extraction: extracts audio track from video files via ffmpeg.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, rm, mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

/**
 * Extract audio track from a video file using ffmpeg.
 * Returns a WAV buffer (16kHz, mono, PCM s16le) suitable for Whisper.
 */
export async function extractAudio(videoBuffer: Buffer, fileName: string): Promise<Buffer> {
  const tempDir = await mkdtemp(join(tmpdir(), 'kivo-ffmpeg-'));
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '.mp4';
  const inputFile = join(tempDir, `${randomUUID()}${ext}`);
  const outputFile = join(tempDir, `${randomUUID()}.wav`);

  try {
    await writeFile(inputFile, videoBuffer);

    await execFileAsync('ffmpeg', [
      '-i', inputFile,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      outputFile,
    ], {
      timeout: 600_000, // 10 minutes max
    });

    const audioBuffer = await readFile(outputFile);
    return audioBuffer;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'ENOENT') {
      throw new Error('ffmpeg command not found. Please install ffmpeg: apt install ffmpeg / brew install ffmpeg');
    }
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}


export interface ExtractedVideoFrame {
  path: string;
  timestampSeconds: number;
  index: number;
}

/** Extracts key frames at a fixed interval and keeps them on disk for source tracing. */
export async function extractKeyFrames(
  videoBuffer: Buffer,
  fileName: string,
  options: { intervalSeconds?: number; outputDir?: string } = {},
): Promise<ExtractedVideoFrame[]> {
  const intervalSeconds = options.intervalSeconds ?? 30;
  const tempDir = await mkdtemp(join(tmpdir(), 'kivo-ffmpeg-frames-'));
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '.mp4';
  const inputFile = join(tempDir, `${randomUUID()}${ext}`);
  const outputDir = options.outputDir ?? join(tempDir, 'frames');
  const outputPattern = join(outputDir, 'frame-%04d.jpg');

  try {
    await writeFile(inputFile, videoBuffer);
    await execFileAsync('mkdir', ['-p', outputDir]);
    await execFileAsync('ffmpeg', [
      '-i', inputFile,
      '-vf', `fps=1/${intervalSeconds}`,
      '-q:v', '3',
      outputPattern,
    ], { timeout: 600_000 });

    const files = (await readdir(outputDir))
      .filter((name) => /^frame-\d+\.jpg$/.test(name))
      .sort();

    return files.map((name, idx) => ({
      path: join(outputDir, name),
      timestampSeconds: idx * intervalSeconds,
      index: idx + 1,
    }));
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'ENOENT') {
      throw new Error('ffmpeg command not found. Please install ffmpeg: apt install ffmpeg / brew install ffmpeg');
    }
    throw error;
  } finally {
    if (!options.outputDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
