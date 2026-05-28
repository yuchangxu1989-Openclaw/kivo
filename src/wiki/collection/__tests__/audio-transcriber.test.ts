/**
 * Tests for WhisperTranscriber: mocks the whisper CLI call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AudioTranscriptionError, DEFAULT_WHISPER_MODEL, WhisperTranscriber } from '../audio-transcriber.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(),
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
const mockRandomUUID = vi.mocked(randomUUID);
const mockMkdtemp = vi.mocked(mkdtemp);
const mockWriteFile = vi.mocked(writeFile);
const mockReadFile = vi.mocked(readFile);
const mockRm = vi.mocked(rm);
const fixtureDir = dirname(fileURLToPath(import.meta.url));
const shortAudioFixture = join(fixtureDir, 'fixtures', 'short-tone.wav');

describe('WhisperTranscriber', () => {
  let transcriber: WhisperTranscriber;

  beforeEach(() => {
    vi.clearAllMocks();
    transcriber = new WhisperTranscriber();
    mockMkdtemp.mockResolvedValue('/tmp/kivo-whisper-abc123' as never);
    mockRandomUUID.mockReturnValue('00000000-0000-4000-8000-000000000000');
    mockWriteFile.mockResolvedValue(undefined as never);
    mockRm.mockResolvedValue(undefined as never);
  });

  it('transcribes audio buffer via local whisper CLI with configurable language/model', async () => {
    const whisperOutput = {
      text: '你好世界，这是一段测试音频。',
      language: 'zh',
      segments: [
        { id: 0, seek: 0, start: 0.0, end: 2.5, text: '你好世界，' },
        { id: 1, seek: 250, start: 2.5, end: 5.0, text: '这是一段测试音频。' },
      ],
    };

    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        (cb as Function)(null, '', '');
      }
      return undefined as never;
    });
    mockReadFile.mockResolvedValue(JSON.stringify(whisperOutput) as never);

    const result = await transcriber.transcribe(Buffer.from('fake-audio'), {
      language: 'zh',
      model: 'base',
      includeSegments: true,
      sourceMediaPath: 'uploads/audio.wav',
    });

    expect(mockExecFile).toHaveBeenCalledWith('whisper', [
      '/tmp/kivo-whisper-abc123/00000000-0000-4000-8000-000000000000.wav',
      '--language', 'zh',
      '--model', 'base',
      '--output_format', 'json',
      '--output_dir', '/tmp/kivo-whisper-abc123',
    ], { timeout: 600_000 }, expect.any(Function));
    expect(result.text).toBe('你好世界，这是一段测试音频。');
    expect(result.language).toBe('zh');
    expect(result.durationSeconds).toBe(5.0);
    expect(result.segments).toEqual([
      { start: 0.0, end: 2.5, text: '你好世界，' },
      { start: 2.5, end: 5.0, text: '这是一段测试音频。' },
    ]);
    expect(mockRm).toHaveBeenCalledWith('/tmp/kivo-whisper-abc123', { recursive: true, force: true });
  });

  it('defaults to zh + tiny and handles empty segments gracefully', async () => {
    const whisperOutput = { text: '', language: 'zh', segments: [] };

    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') (cb as Function)(null, '', '');
      return undefined as never;
    });
    mockReadFile.mockResolvedValue(JSON.stringify(whisperOutput) as never);

    const result = await transcriber.transcribe(Buffer.from('silence'));
    const args = mockExecFile.mock.calls[0][1] as string[];

    expect(args).toContain('--language');
    expect(args[args.indexOf('--language') + 1]).toBe('zh');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe(DEFAULT_WHISPER_MODEL);
    expect(result.text).toBe('');
    expect(result.durationSeconds).toBe(0);
    expect(result.segments).toBeUndefined();
  });

  it('uses a short audio fixture while keeping whisper CLI mocked', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') (cb as Function)(null, '', '');
      return undefined as never;
    });
    mockReadFile.mockResolvedValue(JSON.stringify({
      text: '短音频夹具。',
      language: 'zh',
      segments: [{ start: 0, end: 0.25, text: '短音频夹具。' }],
    }) as never);

    const fixtureBuffer = readFileSync(shortAudioFixture);
    const result = await transcriber.transcribe(fixtureBuffer, { includeSegments: true });

    expect(fixtureBuffer.byteLength).toBeGreaterThan(0);
    expect(result.segments).toEqual([{ start: 0, end: 0.25, text: '短音频夹具。' }]);
  });

  it('rejects unsafe whisper models before invoking whisper to avoid CPU OOM', async () => {
    await expect(transcriber.transcribe(Buffer.from('audio'), {
      model: 'small' as unknown as 'tiny',
    })).rejects.toMatchObject({
      code: 'transcription_failed',
      message: expect.stringContaining('只允许 tiny/base'),
    });

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockMkdtemp).not.toHaveBeenCalled();
  });

  it('rejects oversized audio before invoking whisper and preserves the original audio path', async () => {
    await expect(transcriber.transcribe(Buffer.from('too-large'), {
      maxFileSizeBytes: 3,
      sourceMediaPath: 'uploads/original.wav',
    })).rejects.toMatchObject({
      code: 'audio_oversized',
      originalAudioPath: 'uploads/original.wav',
    });

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockMkdtemp).not.toHaveBeenCalled();
  });

  it('rejects overlong whisper segments with audio_too_long', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') (cb as Function)(null, '', '');
      return undefined as never;
    });
    mockReadFile.mockResolvedValue(JSON.stringify({
      text: '长音频片段',
      language: 'zh',
      segments: [{ start: 0, end: 90, text: '长音频片段' }],
    }) as never);

    await expect(transcriber.transcribe(Buffer.from('audio'), {
      maxSegmentDurationSeconds: 30,
      sourceMediaPath: 'uploads/long.wav',
    })).rejects.toMatchObject({
      code: 'audio_too_long',
      originalAudioPath: 'uploads/long.wav',
    });
    expect(mockRm).toHaveBeenCalledWith('/tmp/kivo-whisper-abc123', { recursive: true, force: true });
  });

  it('maps missing whisper binary to whisper_unavailable', async () => {
    const enoent = Object.assign(new Error('spawn whisper ENOENT'), { code: 'ENOENT' });
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') (cb as Function)(enoent, '', '');
      return undefined as never;
    });

    await expect(transcriber.transcribe(Buffer.from('bad-audio'), {
      sourceMediaPath: 'uploads/check.wav',
    })).rejects.toMatchObject({
      code: 'whisper_unavailable',
      originalAudioPath: 'uploads/check.wav',
    });
    expect(mockRm).toHaveBeenCalledWith('/tmp/kivo-whisper-abc123', { recursive: true, force: true });
  });

  it('wraps generic whisper failures as transcription_failed', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') (cb as Function)(new Error('whisper crashed'), '', '');
      return undefined as never;
    });

    await expect(transcriber.transcribe(Buffer.from('bad-audio'))).rejects.toBeInstanceOf(AudioTranscriptionError);
    await expect(transcriber.transcribe(Buffer.from('bad-audio'))).rejects.toMatchObject({ code: 'transcription_failed' });
  });
});
