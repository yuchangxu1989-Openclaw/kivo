/**
 * Tests for video-extractor: mocks the ffmpeg CLI call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';

const mockExecFile = vi.mocked(execFile);
const mockMkdtemp = vi.mocked(mkdtemp);
const mockWriteFile = vi.mocked(writeFile);
const mockReadFile = vi.mocked(readFile);
const mockRm = vi.mocked(rm);

describe('extractAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdtemp.mockResolvedValue('/tmp/kivo-ffmpeg-xyz789' as never);
    mockWriteFile.mockResolvedValue(undefined as never);
    mockRm.mockResolvedValue(undefined as never);
  });

  it('extracts audio from video via ffmpeg', async () => {
    const fakeWavBuffer = Buffer.from('RIFF-fake-wav-data');

    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        (cb as Function)(null, { stdout: '', stderr: '' });
      }
      return undefined as never;
    });

    mockReadFile.mockResolvedValue(fakeWavBuffer as never);

    // Dynamic import to get the mocked version
    const { extractAudio } = await import('../video-extractor.js');

    const result = await extractAudio(Buffer.from('fake-video-data'), 'demo.mp4');

    expect(result).toEqual(fakeWavBuffer);

    // Verify ffmpeg was called with correct args
    expect(mockExecFile).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1']),
      expect.objectContaining({ timeout: 600_000 }),
      expect.any(Function),
    );

    // Verify temp dir was cleaned up
    expect(mockRm).toHaveBeenCalledWith('/tmp/kivo-ffmpeg-xyz789', { recursive: true, force: true });
  });

  it('uses correct file extension from fileName', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        (cb as Function)(null, { stdout: '', stderr: '' });
      }
      return undefined as never;
    });

    mockReadFile.mockResolvedValue(Buffer.from('wav') as never);

    const { extractAudio } = await import('../video-extractor.js');

    await extractAudio(Buffer.from('data'), 'recording.webm');

    // The input file should have .webm extension
    const writeCall = mockWriteFile.mock.calls[0];
    expect((writeCall[0] as string).endsWith('.webm')).toBe(true);
  });

  it('cleans up temp dir on ffmpeg failure', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        (cb as Function)(new Error('ffmpeg: No audio stream found'), null, null);
      }
      return undefined as never;
    });

    const { extractAudio } = await import('../video-extractor.js');

    await expect(extractAudio(Buffer.from('no-audio-video'), 'silent.mp4')).rejects.toThrow();
    expect(mockRm).toHaveBeenCalledWith('/tmp/kivo-ffmpeg-xyz789', { recursive: true, force: true });
  });

  it('defaults to .mp4 extension when fileName has no extension', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        (cb as Function)(null, { stdout: '', stderr: '' });
      }
      return undefined as never;
    });

    mockReadFile.mockResolvedValue(Buffer.from('wav') as never);

    const { extractAudio } = await import('../video-extractor.js');

    await extractAudio(Buffer.from('data'), 'noext');

    const writeCall = mockWriteFile.mock.calls[0];
    expect((writeCall[0] as string).endsWith('.mp4')).toBe(true);
  });
});
