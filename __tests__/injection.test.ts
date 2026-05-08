import { describe, it, expect } from 'vitest';
import { RelevanceScorer, cosineSimilarity } from '../src/injection/relevance-scorer.js';
import { InjectionFormatter, estimateTokens } from '../src/injection/injection-formatter.js';
import { InjectionPolicy } from '../src/injection/injection-policy.js';
import { ContextInjector } from '../src/injection/context-injector.js';
import type { KnowledgeEntry, KnowledgeSource } from '../src/types/index.js';
import type { EmbeddingProvider } from '../src/injection/spi.js';
import type { KnowledgeRepository } from '../src/repository/index.js';
import type { SearchResult, SemanticQuery } from '../src/repository/storage-provider.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

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
    content: 'Test content about TypeScript',
    summary: 'A test summary',
    source: testSource,
    confidence: 0.9,
    status: 'active',
    tags: ['test'],
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
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
    return norm > 0 ? vec.map(v => v / norm) : vec;
  }
}

/** Minimal mock that returns pre-configured search results */
class MockRepository {
  private results: SearchResult[] = [];

  setResults(results: SearchResult[]) {
    this.results = results;
  }

  async search(_query: SemanticQuery): Promise<SearchResult[]> {
    return this.results;
  }

  // Stubs for KnowledgeRepository interface
  async save() {}
  async findById() { return null; }
  async updateStatus() {}
  async getVersionHistory() { return []; }
  async findByType() { return []; }
  async fullTextSearch() { return []; }
  async delete() {}
  async count() { return 0; }
  async close() {}
}

// ─── cosineSimilarity ────────────────────────────────────────────────────────

describe('cosineSimilarity (injection)', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

// ─── estimateTokens ──────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abc')).toBe(1); // ceil(3/4) = 1
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

// ─── RelevanceScorer ─────────────────────────────────────────────────────────

describe('RelevanceScorer', () => {
  it('scores entries by keyword match (no embedding)', async () => {
    const scorer = new RelevanceScorer();
    const entries = [
      makeEntry({ id: 'e1', title: 'TypeScript strict mode', content: 'TypeScript strict mode enables better type checking' }),
      makeEntry({ id: 'e2', title: 'Python decorators', content: 'Python decorators are syntactic sugar' }),
    ];

    const scored = await scorer.score('TypeScript strict', entries);
    expect(scored).toHaveLength(2);
    // e1 should score higher (more keyword overlap with query)
    expect(scored[0].entry.id).toBe('e1');
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });

  it('returns empty array for empty entries', async () => {
    const scorer = new RelevanceScorer();
    const scored = await scorer.score('anything', []);
    expect(scored).toHaveLength(0);
  });

  it('uses embedding provider when available', async () => {
    const scorer = new RelevanceScorer({
      embeddingProvider: new MockEmbeddingProvider(),
      keywordWeight: 0.3,
      embeddingWeight: 0.7,
    });

    const entries = [
      makeEntry({ id: 'e1', title: 'TypeScript strict mode', content: 'TypeScript strict mode config' }),
      makeEntry({ id: 'e2', title: 'Unrelated topic', content: 'Something completely different about cooking' }),
    ];

    const scored = await scorer.score('TypeScript strict', entries);
    expect(scored).toHaveLength(2);
    // Both scores should be numbers
    expect(typeof scored[0].score).toBe('number');
    expect(typeof scored[1].score).toBe('number');
  });

  it('assigns 0 score when query has no matching keywords', async () => {
    const scorer = new RelevanceScorer();
    const entries = [
      makeEntry({ id: 'e1', title: 'Alpha Beta', content: 'Gamma Delta' }),
    ];

    const scored = await scorer.score('zzz yyy', entries);
    expect(scored[0].score).toBe(0);
  });
});

// ─── InjectionFormatter ──────────────────────────────────────────────────────

describe('InjectionFormatter', () => {
  const entry = makeEntry({
    id: 'fmt-1',
    title: 'Test Title',
    type: 'methodology',
    summary: 'A methodology summary',
    confidence: 0.85,
    source: { ...testSource, reference: 'doc://test' },
  });

  it('formats as markdown by default', () => {
    const formatter = new InjectionFormatter();
    const block = formatter.formatEntry(entry);

    expect(block.entryId).toBe('fmt-1');
    expect(block.text).toContain('### Test Title');
    expect(block.text).toContain('methodology');
    expect(block.text).toContain('0.85');
    expect(block.text).toContain('A methodology summary');
    expect(block.text).toContain('doc://test');
    expect(block.estimatedTokens).toBeGreaterThan(0);
  });

  it('formats as plain text', () => {
    const formatter = new InjectionFormatter('plain');
    const block = formatter.formatEntry(entry);

    expect(block.text).toContain('[METHODOLOGY] Test Title');
    expect(block.text).toContain('A methodology summary');
    expect(block.text).toContain('doc://test');
    expect(block.text).not.toContain('###');
  });

  it('falls back to content when summary is empty', () => {
    const noSummary = makeEntry({ id: 'ns-1', summary: '', content: 'Fallback content here' });
    const formatter = new InjectionFormatter('plain');
    const block = formatter.formatEntry(noSummary);

    expect(block.text).toContain('Fallback content here');
  });

  it('formats multiple entries', () => {
    const entries = [
      makeEntry({ id: 'multi-1' }),
      makeEntry({ id: 'multi-2' }),
    ];
    const formatter = new InjectionFormatter();
    const blocks = formatter.formatEntries(entries);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].entryId).toBe('multi-1');
    expect(blocks[1].entryId).toBe('multi-2');
  });
});

// ─── InjectionPolicy ─────────────────────────────────────────────────────────

describe('InjectionPolicy', () => {
  function makeScoredEntry(id: string, score: number, title?: string) {
    const entry = makeEntry({ id, title: title ?? `Entry ${id}` });
    return { entry, score };
  }

  function makeBlock(entryId: string, tokens: number): { text: string; entryId: string; estimatedTokens: number } {
    return { text: 'x'.repeat(tokens * 4), entryId, estimatedTokens: tokens };
  }

  it('selects entries within token budget', () => {
    const scored = [
      makeScoredEntry('a', 0.9),
      makeScoredEntry('b', 0.8),
      makeScoredEntry('c', 0.7),
    ];
    const blocks = [
      makeBlock('a', 100),
      makeBlock('b', 100),
      makeBlock('c', 100),
    ];

    const policy = new InjectionPolicy({ maxTokens: 250 });
    const result = policy.apply(scored, blocks);

    expect(result.selected).toHaveLength(2);
    expect(result.tokensUsed).toBe(200);
    expect(result.truncated).toBe(true);
    expect(result.droppedCount).toBe(1);
  });

  it('filters by minimum score', () => {
    const scored = [
      makeScoredEntry('a', 0.9),
      makeScoredEntry('b', 0.05), // below default 0.1
    ];
    const blocks = [
      makeBlock('a', 50),
      makeBlock('b', 50),
    ];

    const policy = new InjectionPolicy({ maxTokens: 1000 });
    const result = policy.apply(scored, blocks);

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].entryId).toBe('a');
  });

  it('deduplicates by title similarity', () => {
    const scored = [
      makeScoredEntry('a', 0.9, 'TypeScript strict mode'),
      makeScoredEntry('b', 0.8, 'TypeScript strict mode guide'), // near-duplicate title
    ];
    const blocks = [
      makeBlock('a', 50),
      makeBlock('b', 50),
    ];

    const policy = new InjectionPolicy({ maxTokens: 1000, deduplicateThreshold: 0.6 });
    const result = policy.apply(scored, blocks);

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].entryId).toBe('a'); // higher score wins
  });

  it('prioritizes preferred types', () => {
    const scored = [
      { entry: makeEntry({ id: 'a', type: 'fact', title: 'Fact about testing' }), score: 0.9 },
      { entry: makeEntry({ id: 'b', type: 'decision', title: 'Decision about architecture' }), score: 0.85 },
    ];
    const blocks = [
      makeBlock('a', 50),
      makeBlock('b', 50),
    ];

    const policy = new InjectionPolicy({
      maxTokens: 60, // only room for one
      preferredTypes: ['decision'],
    });
    const result = policy.apply(scored, blocks);

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].entryId).toBe('b'); // decision preferred
  });

  it('returns empty when all below minScore', () => {
    const scored = [
      makeScoredEntry('a', 0.01),
      makeScoredEntry('b', 0.02),
    ];
    const blocks = [
      makeBlock('a', 50),
      makeBlock('b', 50),
    ];

    const policy = new InjectionPolicy({ maxTokens: 1000, minScore: 0.5 });
    const result = policy.apply(scored, blocks);

    expect(result.selected).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(result.tokensUsed).toBe(0);
  });
});

// ─── ContextInjector ─────────────────────────────────────────────────────────

describe('ContextInjector', () => {
  it('returns empty response when repository has no matches', async () => {
    const repo = new MockRepository();
    repo.setResults([]);

    const injector = new ContextInjector({
      repository: repo as unknown as KnowledgeRepository,
    });

    const response = await injector.inject({
      userQuery: 'TypeScript best practices',
      tokenBudget: 500,
    });

    expect(response.injectedContext).toBe('');
    expect(response.entries).toHaveLength(0);
    expect(response.tokensUsed).toBe(0);
    expect(response.truncated).toBe(false);
  });

  it('injects relevant entries within token budget', async () => {
    const entry1 = makeEntry({
      id: 'inj-1',
      title: 'TypeScript strict mode',
      content: 'Enable strict mode in TypeScript for better type safety',
      summary: 'TypeScript strict mode improves type safety',
      type: 'methodology',
    });
    const entry2 = makeEntry({
      id: 'inj-2',
      title: 'TypeScript generics',
      content: 'TypeScript generics enable reusable typed components',
      summary: 'Generics for reusable TypeScript code',
      type: 'fact',
    });

    const repo = new MockRepository();
    repo.setResults([
      { entry: entry1, score: 0.9 },
      { entry: entry2, score: 0.7 },
    ]);

    const injector = new ContextInjector({
      repository: repo as unknown as KnowledgeRepository,
    });

    const response = await injector.inject({
      userQuery: 'TypeScript strict',
      tokenBudget: 5000,
    });

    expect(response.entries.length).toBeGreaterThanOrEqual(1);
    expect(response.injectedContext).toContain('TypeScript');
    expect(response.tokensUsed).toBeGreaterThan(0);
  });

  it('respects token budget and truncates', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({
        id: `big-${i}`,
        title: `Entry number ${i}`,
        content: 'Entry number content about topic ' + 'x'.repeat(200),
        summary: `Summary for entry number ${i}`,
      })
    );

    const repo = new MockRepository();
    repo.setResults(entries.map((e, i) => ({ entry: e, score: 0.9 - i * 0.05 })));

    const injector = new ContextInjector({
      repository: repo as unknown as KnowledgeRepository,
    });

    const response = await injector.inject({
      userQuery: 'Entry number',
      tokenBudget: 200, // tight budget
      minScore: 0,       // accept all scores so budget is the limiting factor
    });

    expect(response.tokensUsed).toBeLessThanOrEqual(200);
    expect(response.entries.length).toBeLessThan(10);
    expect(response.truncated).toBe(true);
  });

  it('uses preferred types filter', async () => {
    const factEntry = makeEntry({ id: 'f1', type: 'fact', title: 'A fact about TS' });
    const decisionEntry = makeEntry({ id: 'd1', type: 'decision', title: 'Decision about TS' });

    const repo = new MockRepository();
    repo.setResults([
      { entry: factEntry, score: 0.8 },
      { entry: decisionEntry, score: 0.8 },
    ]);

    const injector = new ContextInjector({
      repository: repo as unknown as KnowledgeRepository,
    });

    const response = await injector.inject({
      userQuery: 'TS',
      tokenBudget: 5000,
      preferredTypes: ['decision'],
    });

    // Both should be included (budget is large), but decision should appear in entries
    expect(response.entries.some(e => e.type === 'decision')).toBe(true);
  });

  it('supports plain text format', async () => {
    const entry = makeEntry({ id: 'plain-1', title: 'Plain Test', type: 'experience' });

    const repo = new MockRepository();
    repo.setResults([{ entry, score: 0.9 }]);

    const injector = new ContextInjector({
      repository: repo as unknown as KnowledgeRepository,
    });

    const response = await injector.inject({
      userQuery: 'Plain Test',
      tokenBudget: 5000,
      format: 'plain',
    });

    expect(response.injectedContext).toContain('[EXPERIENCE]');
    expect(response.injectedContext).not.toContain('###');
  });

  it('uses injected scorerInstance when provided', async () => {
    const entry1 = makeEntry({
      id: 'sem-1',
      title: 'Semantic search basics',
      content: 'Semantic search uses embeddings for similarity',
      summary: 'Semantic search overview',
      type: 'fact',
    });
    const entry2 = makeEntry({
      id: 'sem-2',
      title: 'Keyword matching',
      content: 'Traditional keyword matching is simple',
      summary: 'Keyword matching overview',
      type: 'fact',
    });

    const repo = new MockRepository();
    repo.setResults([
      { entry: entry1, score: 0.8 },
      { entry: entry2, score: 0.7 },
    ]);

    // Custom scorer that always returns entries in reverse order with fixed scores
    let scorerCalled = false;
    const customScorer = {
      async score(_query: string, entries: KnowledgeEntry[]) {
        scorerCalled = true;
        // Return in reverse order to prove custom scorer is used
        return entries.map((entry, i) => ({
          entry,
          score: 1.0 - i * 0.1,
        })).reverse();
      },
    };

    const injector = new ContextInjector({
      repository: repo as unknown as KnowledgeRepository,
      scorerInstance: customScorer,
    });

    const response = await injector.inject({
      userQuery: 'semantic search',
      tokenBudget: 5000,
    });

    expect(scorerCalled).toBe(true);
    expect(response.entries.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to default RelevanceScorer when no scorerInstance provided', async () => {
    const entry = makeEntry({
      id: 'fallback-1',
      title: 'Fallback test entry',
      content: 'This tests the fallback path without scorer injection',
      summary: 'Fallback scorer test',
      type: 'methodology',
    });

    const repo = new MockRepository();
    repo.setResults([{ entry, score: 0.9 }]);

    // No scorerInstance — should use default RelevanceScorer (keyword-based)
    const injector = new ContextInjector({
      repository: repo as unknown as KnowledgeRepository,
    });

    const response = await injector.inject({
      userQuery: 'Fallback test',
      tokenBudget: 5000,
    });

    // Should still work with default scorer
    expect(response.entries).toHaveLength(1);
    expect(response.entries[0].entryId).toBe('fallback-1');
    expect(response.tokensUsed).toBeGreaterThan(0);
  });

  it('scorerInstance with SemanticRelevanceScorer produces semantic scores', async () => {
    const entry1 = makeEntry({
      id: 'srs-1',
      title: 'Machine learning fundamentals',
      content: 'Neural networks and deep learning concepts',
      summary: 'ML basics',
      type: 'fact',
    });
    const entry2 = makeEntry({
      id: 'srs-2',
      title: 'Cooking recipes',
      content: 'How to make pasta from scratch',
      summary: 'Pasta recipe',
      type: 'fact',
    });

    const repo = new MockRepository();
    repo.setResults([
      { entry: entry1, score: 0.8 },
      { entry: entry2, score: 0.7 },
    ]);

    // Use real SemanticRelevanceScorer with mock embedding
    const { SemanticRelevanceScorer } = await import('../src/search/search-integration.js');
    const semanticScorer = new SemanticRelevanceScorer({
      embeddingProvider: new MockEmbeddingProvider(),
    });

    const injector = new ContextInjector({
      repository: repo as unknown as KnowledgeRepository,
      scorerInstance: semanticScorer,
    });

    const response = await injector.inject({
      userQuery: 'machine learning neural networks',
      tokenBudget: 5000,
      minScore: 0,
    });

    // Both entries should be scored and returned
    expect(response.entries.length).toBe(2);
    expect(response.tokensUsed).toBeGreaterThan(0);
  });
});
