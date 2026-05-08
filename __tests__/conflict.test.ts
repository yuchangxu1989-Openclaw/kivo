import { describe, it, expect } from 'vitest';
import { ConflictDetector, cosineSimilarity, keywordOverlap } from '../src/conflict/conflict-detector.js';
import { ConflictResolver } from '../src/conflict/conflict-resolver.js';
import type { KnowledgeEntry, KnowledgeSource } from '../src/types/index.js';
import type { EmbeddingProvider, LLMJudgeProvider } from '../src/conflict/spi.js';
import type { ConflictRecord, ConflictVerdict } from '../src/conflict/conflict-record.js';

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'unit-test',
  timestamp: new Date(),
};

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    type: 'fact',
    title: 'Test Entry',
    content: 'Test content',
    summary: 'Test summary',
    source: testSource,
    confidence: 0.9,
    status: 'active',
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

class MockEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const vec = new Array(8).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % 8] += text.charCodeAt(i) / 1000;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? vec.map(v => v / norm) : vec;
  }
}

class MockLLMJudge implements LLMJudgeProvider {
  private responses: Map<string, ConflictVerdict> = new Map();

  setResponse(incomingId: string, existingId: string, verdict: ConflictVerdict) {
    this.responses.set(`${incomingId}:${existingId}`, verdict);
  }

  async judgeConflict(incoming: KnowledgeEntry, existing: KnowledgeEntry): Promise<ConflictVerdict> {
    return this.responses.get(`${incoming.id}:${existing.id}`) ?? 'compatible';
  }
}

describe('cosineSimilarity', () => {
  it('should return 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it('should return 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('should return -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('should return 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('should handle mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe('keywordOverlap', () => {
  it('should return 1 for identical strings', () => {
    expect(keywordOverlap('hello world', 'hello world')).toBeCloseTo(1);
  });

  it('should return 0 for no overlap', () => {
    expect(keywordOverlap('hello world', 'foo bar')).toBe(0);
  });

  it('should handle partial overlap', () => {
    const overlap = keywordOverlap('hello world foo', 'hello bar baz');
    expect(overlap).toBeGreaterThan(0);
    expect(overlap).toBeLessThan(1);
  });

  it('should be case insensitive', () => {
    expect(keywordOverlap('Hello World', 'hello world')).toBeCloseTo(1);
  });
});

describe('ConflictDetector', () => {
  it('should return no conflicts for empty existing set', async () => {
    const llm = new MockLLMJudge();
    const detector = new ConflictDetector({ llmJudgeProvider: llm });
    const incoming = makeEntry({ id: 'new1' });
    const conflicts = await detector.detect(incoming, []);
    expect(conflicts).toHaveLength(0);
  });

  it('should detect conflict via LLM when keyword overlap is high (no embedding)', async () => {
    const llm = new MockLLMJudge();
    const incoming = makeEntry({ id: 'new1', title: 'TypeScript strict mode', type: 'fact' });
    const existing = makeEntry({ id: 'old1', title: 'TypeScript strict mode config', type: 'fact' });
    llm.setResponse('new1', 'old1', 'conflict');

    const detector = new ConflictDetector({ llmJudgeProvider: llm });
    const conflicts = await detector.detect(incoming, [existing]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].incomingId).toBe('new1');
    expect(conflicts[0].existingId).toBe('old1');
    expect(conflicts[0].verdict).toBe('conflict');
  });

  it('should detect rule conflict for intent entries with opposite directives', async () => {
    const llm = new MockLLMJudge();
    const incoming = makeEntry({
      id: 'rule-new',
      type: 'intent',
      title: 'Deletion approval policy',
      content: 'Agents must ask for user confirmation before deleting files.',
    });
    const existing = makeEntry({
      id: 'rule-old',
      type: 'intent',
      title: 'File deletion policy',
      content: 'Agents must not ask for user confirmation before deleting files.',
    });

    const detector = new ConflictDetector({ llmJudgeProvider: llm });
    const conflicts = await detector.detect(incoming, [existing]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].incomingId).toBe('rule-new');
    expect(conflicts[0].existingId).toBe('rule-old');
  });

  it('should not flag compatible entries as conflicts', async () => {
    const llm = new MockLLMJudge();
    const incoming = makeEntry({ id: 'new2', title: 'React hooks best practice', type: 'methodology' });
    const existing = makeEntry({ id: 'old2', title: 'React hooks best practice guide', type: 'methodology' });
    llm.setResponse('new2', 'old2', 'compatible');

    const detector = new ConflictDetector({ llmJudgeProvider: llm });
    const conflicts = await detector.detect(incoming, [existing]);
    expect(conflicts).toHaveLength(0);
  });

  it('should skip entries of different types', async () => {
    const llm = new MockLLMJudge();
    const incoming = makeEntry({ id: 'new3', title: 'same title', type: 'fact' });
    const existing = makeEntry({ id: 'old3', title: 'same title', type: 'decision' });
    llm.setResponse('new3', 'old3', 'conflict');

    const detector = new ConflictDetector({ llmJudgeProvider: llm });
    const conflicts = await detector.detect(incoming, [existing]);
    expect(conflicts).toHaveLength(0);
  });

  it('should use embedding provider when available', async () => {
    const embedding = new MockEmbeddingProvider();
    const llm = new MockLLMJudge();
    const incoming = makeEntry({ id: 'emb1', content: 'TypeScript is great', type: 'fact' });
    const existing = makeEntry({ id: 'emb2', content: 'TypeScript is great', type: 'fact' });
    llm.setResponse('emb1', 'emb2', 'conflict');

    const detector = new ConflictDetector({
      embeddingProvider: embedding,
      llmJudgeProvider: llm,
      similarityThreshold: 0.85,
    });
    const conflicts = await detector.detect(incoming, [existing]);
    expect(conflicts).toHaveLength(1);
  });
});

describe('ConflictResolver', () => {
  const resolver = new ConflictResolver();

  const baseRecord: ConflictRecord = {
    id: 'cr1',
    incomingId: 'new1',
    existingId: 'old1',
    verdict: 'conflict',
    detectedAt: new Date(),
    resolved: false,
  };

  it('newer-wins: incoming wins when newer', () => {
    const incoming = makeEntry({ id: 'new1', createdAt: new Date('2026-04-19') });
    const existing = makeEntry({ id: 'old1', createdAt: new Date('2026-04-01') });
    const result = resolver.resolve(baseRecord, incoming, existing, 'newer-wins');
    expect(result.winnerId).toBe('new1');
    expect(result.loserId).toBe('old1');
    expect(result.action).toBe('supersede');
    expect(result.record.resolved).toBe(true);
  });

  it('newer-wins: existing wins when newer', () => {
    const incoming = makeEntry({ id: 'new1', createdAt: new Date('2026-03-01') });
    const existing = makeEntry({ id: 'old1', createdAt: new Date('2026-04-19') });
    const result = resolver.resolve(baseRecord, incoming, existing, 'newer-wins');
    expect(result.winnerId).toBe('old1');
    expect(result.loserId).toBe('new1');
  });

  it('confidence-wins: higher confidence wins', () => {
    const incoming = makeEntry({ id: 'new1', confidence: 0.95 });
    const existing = makeEntry({ id: 'old1', confidence: 0.7 });
    const result = resolver.resolve(baseRecord, incoming, existing, 'confidence-wins');
    expect(result.winnerId).toBe('new1');
    expect(result.action).toBe('supersede');
  });

  it('manual: marks as pending', () => {
    const incoming = makeEntry({ id: 'new1' });
    const existing = makeEntry({ id: 'old1' });
    const result = resolver.resolve(baseRecord, incoming, existing, 'manual');
    expect(result.action).toBe('pending_manual');
    expect(result.record.resolved).toBe(false);
  });
});
