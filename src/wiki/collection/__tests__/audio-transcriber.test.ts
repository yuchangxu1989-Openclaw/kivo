/**
 * Tests for WhisperTranscriber: mocks the whisper CLI call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WhisperTranscriber } from '../audio-transcriber.js';

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

describe('WhisperTranscriber', () => {
  const transcriber = new WhisperTranscriber();

  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdtemp.mockResolvedValue('/tmp/kivo-whisper-abc123' as never);
    mockWriteFile.mockResolvedValue(undefined as never);
    mockRm.mockResolvedValue(undefined as never);
  });

  it('transcribes audio buffer via whisper CLI', async () => {
    const whisperOutput = {
      text: '你好世界，这是一段测试音频。',
      language: 'zh',
      segments: [
        { id: 0, seek: 0, start: 0.0, end: 2.5, text: '你好世界，' },
        { id: 1, seek: 250, start: 2.5, end: 5.0, text: '这是一段测试音频。' },
      ],
    };

    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      if (typeof callback === 'function') {
        callback(null, '', '');
      }
      return undefined as never;
    });

    // execFile is promisified, so mock the callback-style to resolve
    const { promisify } = await import('node:util');
    // Re-mock to handle promisified version
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        (cb as Function)(null, { stdout: '', stderr: '' });
      }
      return undefined as never;
    });

    mockReadFile.mockResolvedValue(JSON.stringify(whisperOutput) as never);

    const result = await transcriber.transcribe(Buffer.from('fake-audio'), {
      language: 'zh',
      model: 'base',
      includeSegments: true,
    });

    expect(result.text).toBe('你好世界，这是一段测试音频。');
    expect(result.language).toBe('zh');
    expect(result.durationSeconds).toBe(5.0);
    expect(result.segments).toHaveLength(2);
    expect(result.segments![0]).toEqual({ start: 0.0, end: 2.5, text: '你好世界，' });
    expect(result.segments![1]).toEqual({ start: 2.5, end: 5.0, text: '这是一段测试音频。' });

    // Verify temp dir was cleaned up
    expect(mockRm).toHaveBeenCalledWith('/tmp/kivo-whisper-abc123', { recursive: true, force: true });
  });

  it('handles empty segments gracefully', async () => {
    const whisperOutput = {
      text: '',
      language: 'zh',
      segments: [],
    };

    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        (cb as Function)(null, { stdout: '', stderr: '' });
      }
      return undefined as never;
    });

    mockReadFile.mockResolvedValue(JSON.stringify(whisperOutput) as never);

    const result = await transcriber.transcribe(Buffer.from('silence'));

    expect(result.text).toBe('');
    expect(result.durationSeconds).toBe(0);
    expect(result.segments).toBeUndefined();
  });

  it('cleans up temp dir on error', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        (cb as Function)(new Error('whisper crashed'), null, null);
      }
      return undefined as never;
    });

    await expect(transcriber.transcribe(Buffer.from('bad-audio'))).rejects.toThrow();
    expect(mockRm).toHaveBeenCalledWith('/tmp/kivo-whisper-abc123', { recursive: true, force: true });
  });
});
