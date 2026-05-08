import { describe, expect, it, vi } from 'vitest';
import { ConflictDetector, keywordOverlap } from '../conflict-detector.js';
import type { KnowledgeEntry } from '../../types/index.js';
import type { EmbeddingProvider, LLMJudgeProvider } from '../spi.js';
import type { ConflictVerdict } from '../conflict-record.js';

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: overrides.id ?? 'e-1',
    type: overrides.type ?? 'fact',
    title: overrides.title ?? 'Test Entry',
    content: overrides.content ?? 'Some content',
    summary: 's',
    source: { type: 'manual', reference: 'test', timestamp: new Date() },
    confidence: 0.9,
    status: overrides.status ?? 'active',
    tags: [],
    domain: 'default',
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

function mockLLM(verdict: ConflictVerdict = 'conflict'): LLMJudgeProvider {
  return { judgeConflict: vi.fn().mockResolvedValue(verdict) };
}

function mockEmbedding(vectors: Map<string, number[]>): EmbeddingProvider {
  return {
    embed: vi.fn(async (text: string) => vectors.get(text) ?? [0, 0, 0]),
  };
}

describe('ConflictDetector', () => {
  it('returns empty array when no existing entries', async () => {
    const detector = new ConflictDetector({ llmJudgeProvider: mockLLM() });
    const result = await detector.detect(makeEntry(), []);
    expect(result).toEqual([]);
  });

  it('skips entries of different type in phase1', async () => {
    const llm = mockLLM();
    const detector = new ConflictDetector({ llmJudgeProvider: llm });
    const incoming = makeEntry({ type: 'fact' });
    const existing = [makeEntry({ id: 'e-2', type: 'methodology' })];
    const result = await detector.detect(incoming, existing);
    expect(result).toEqual([]);
    expect(llm.judgeConflict).not.toHaveBeenCalled();
  });

  it('detects conflict via embedding similarity + LLM judge', async () => {
    const vec = [1, 0, 0];
    const vectors = new Map<string, number[]>();
    vectors.set('Content A', vec);
    vectors.set('Content B', vec); // identical = similarity 1.0

    const detector = new ConflictDetector({
      embeddingProvider: mockEmbedding(vectors),
      llmJudgeProvider: mockLLM('conflict'),
      similarityThreshold: 0.85,
    });

    const incoming = makeEntry({ id: 'in', content: 'Content A' });
    const existing = [makeEntry({ id: 'ex', content: 'Content B' })];
    const result = await detector.detect(incoming, existing);

    expect(result).toHaveLength(1);
    expect(result[0].incomingId).toBe('in');
    expect(result[0].existingId).toBe('ex');
    expect(result[0].verdict).toBe('conflict');
    expect(result[0].resolved).toBe(false);
  });

  it('no conflict when embedding similarity below threshold', async () => {
    const vectors = new Map<string, number[]>();
    vectors.set('Content A', [1, 0, 0]);
    vectors.set('Content B', [0, 1, 0]); // orthogonal = similarity 0

    const llm = mockLLM('conflict');
    const detector = new ConflictDetector({
      embeddingProvider: mockEmbedding(vectors),
      llmJudgeProvider: llm,
    });

    const result = await detector.detect(
      makeEntry({ content: 'Content A' }),
      [makeEntry({ id: 'ex', content: 'Content B' })],
    );
    expect(result).toEqual([]);
    expect(llm.judgeConflict).not.toHaveBeenCalled();
  });

  it('detects rule conflict for intent entries with opposing polarity', async () => {
    const llm = mockLLM('compatible');
    const detector = new ConflictDetector({ llmJudgeProvider: llm });

    const incoming = makeEntry({
      id: 'in',
      type: 'intent',
      title: 'database access policy',
      content: 'Users must not access the database directly',
    });
    const existing = [makeEntry({
      id: 'ex',
      type: 'intent',
      title: 'database access policy',
      content: 'Users must access the database directly',
    })];

    const result = await detector.detect(incoming, existing);
    expect(result).toHaveLength(1);
    expect(result[0].verdict).toBe('conflict');
  });

  it('falls back to metadata matching when no embedding provider', async () => {
    const detector = new ConflictDetector({
      llmJudgeProvider: mockLLM('conflict'),
    });

    // High keyword overlap in title
    const incoming = makeEntry({ id: 'in', title: 'deploy production server config' });
    const existing = [makeEntry({ id: 'ex', title: 'deploy production server config update' })];

    const result = await detector.detect(incoming, existing);
    expect(result).toHaveLength(1);
  });
});

describe('keywordOverlap', () => {
  it('returns 0 for empty strings', () => {
    expect(keywordOverlap('', '')).toBe(0);
  });

  it('returns 1 for identical strings', () => {
    expect(keywordOverlap('hello world', 'hello world')).toBe(1);
  });

  it('returns partial overlap', () => {
    const overlap = keywordOverlap('hello world foo', 'hello world bar');
    expect(overlap).toBeGreaterThan(0);
    expect(overlap).toBeLessThan(1);
  });

  it('is case insensitive', () => {
    expect(keywordOverlap('Hello World', 'hello world')).toBe(1);
  });
});
