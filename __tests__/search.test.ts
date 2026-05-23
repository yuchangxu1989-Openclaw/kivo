import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VectorIndex, cosineSimilarity, SemanticSearch, SemanticRelevanceScorer } from '../src/search/index.js';
import { LocalEmbedding } from '../src/embedding/local-embedding.js';
import { ContextInjector } from '../src/injection/context-injector.js';
import { Kivo } from '../src/kivo.js';
import type { KivoConfig } from '../src/config.js';
import type { KnowledgeEntry } from '../src/types/index.js';
import type { StorageProvider, SemanticQuery, SearchResult as RepoSearchResult } from '../src/repository/storage-provider.js';
import type { EntryStatus, KnowledgeType } from '../src/types/index.js';
import { KnowledgeRepository } from '../src/repository/knowledge-repository.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<KnowledgeEntry> & { id: string }): KnowledgeEntry {
  return {
    type: 'fact',
    title: 'Test Entry',
    content: 'test content',
    summary: 'test summary',
    source: { type: 'manual', reference: 'test', timestamp: new Date() },
    confidence: 0.9,
    status: 'active',
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

// ─── VectorIndex: 余弦相似度正确性 ──────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('identical vectors → 1', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it('orthogonal vectors → 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('opposite vectors → -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('empty vectors → 0', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('mismatched lengths → 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('zero vector → 0', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('known angle (45°) → ~0.707', () => {
    expect(cosineSimilarity([1, 0], [1, 1])).toBeCloseTo(Math.SQRT1_2, 4);
  });
});

// ─── VectorIndex: add/search/remove ─────────────────────────────────────────

describe('VectorIndex', () => {
  let index: VectorIndex;

  beforeEach(() => {
    index = new VectorIndex();
  });

  it('starts empty', () => {
    expect(index.size()).toBe(0);
  });

  it('add and search', () => {
    index.addVector('a', [1, 0, 0]);
    index.addVector('b', [0, 1, 0]);
    index.addVector('c', [0.9, 0.1, 0]);

    const results = index.search([1, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('a');
    expect(results[0].score).toBeCloseTo(1);
    expect(results[1].id).toBe('c');
  });

  it('remove returns true for existing, false for missing', () => {
    index.addVector('x', [1, 0]);
    expect(index.remove('x')).toBe(true);
    expect(index.remove('x')).toBe(false);
    expect(index.size()).toBe(0);
  });

  it('search with topK larger than index size', () => {
    index.addVector('a', [1, 0]);
    const results = index.search([1, 0], 100);
    expect(results).toHaveLength(1);
  });

  it('overwrite vector for same id', () => {
    index.addVector('a', [1, 0]);
    index.addVector('a', [0, 1]);
    expect(index.size()).toBe(1);
    const results = index.search([0, 1], 1);
    expect(results[0].id).toBe('a');
    expect(results[0].score).toBeCloseTo(1);
  });
});

// ─── SemanticSearch: 端到端（LocalEmbedding）────────────────────────────────

describe('SemanticSearch', () => {
  let embedding: LocalEmbedding;
  let index: VectorIndex;
  let search: SemanticSearch;

  beforeEach(() => {
    embedding = new LocalEmbedding(64);
    index = new VectorIndex();
    search = new SemanticSearch(embedding, index);
  });

  it('indexEntry + search returns relevant result', async () => {
    const entry = makeEntry({ id: 'e1', title: 'TypeScript generics', content: 'TypeScript generics enable type-safe reusable code', summary: 'generics' });
    await search.indexEntry(entry);

    const results = await search.search('TypeScript generics', 5);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('e1');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('indexBatch indexes multiple entries', async () => {
    const entries = [
      makeEntry({ id: 'b1', title: 'React hooks', content: 'useState useEffect', summary: 'hooks' }),
      makeEntry({ id: 'b2', title: 'Vue composition', content: 'ref reactive computed', summary: 'composition' }),
      makeEntry({ id: 'b3', title: 'Angular signals', content: 'signal effect computed', summary: 'signals' }),
    ];
    await search.indexBatch(entries);

    const results = await search.search('React hooks useState', 3);
    expect(results).toHaveLength(3);
    // React entry should rank highest for a React query
    expect(results[0].id).toBe('b1');
  });

  it('clear removes all indexed entries', async () => {
    await search.indexEntry(makeEntry({ id: 'c1', title: 'test', content: 'test', summary: 'test' }));
    expect(index.size()).toBe(1);
    search.clear();
    expect(index.size()).toBe(0);
  });
});

// ─── SemanticRelevanceScorer + ContextInjector 集成 ──────────────────────────

describe('SemanticRelevanceScorer', () => {
  it('scores entries by semantic + keyword relevance', async () => {
    const embedding = new LocalEmbedding(64);
    const scorer = new SemanticRelevanceScorer({ embeddingProvider: embedding });

    const entries = [
      makeEntry({ id: 's1', title: 'machine learning basics', content: 'neural networks deep learning', summary: 'ML intro', tags: ['ml'] }),
      makeEntry({ id: 's2', title: 'cooking recipes', content: 'pasta sauce ingredients', summary: 'food', tags: ['cooking'] }),
    ];

    const scored = await scorer.score('machine learning neural networks', entries);
    expect(scored).toHaveLength(2);
    // ML entry should score higher than cooking for an ML query
    expect(scored[0].entry.id).toBe('s1');
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });

  it('returns empty for empty entries', async () => {
    const embedding = new LocalEmbedding(64);
    const scorer = new SemanticRelevanceScorer({ embeddingProvider: embedding });
    const scored = await scorer.score('anything', []);
    expect(scored).toHaveLength(0);
  });
});

describe('SemanticRelevanceScorer + ContextInjector integration', () => {
  it('ContextInjector uses SemanticRelevanceScorer for scoring', async () => {
    const embedding = new LocalEmbedding(64);

    const entries = [
      makeEntry({ id: 'i1', title: 'vector databases', content: 'FAISS Pinecone Milvus vector similarity search', summary: 'vector DB overview', tags: ['vector'] }),
      makeEntry({ id: 'i2', title: 'SQL databases', content: 'PostgreSQL MySQL relational queries', summary: 'SQL overview', tags: ['sql'] }),
    ];

    // Minimal in-memory StorageProvider for test
    const mockProvider: StorageProvider = {
      save: async () => {},
      findById: async (id) => entries.find(e => e.id === id) ?? null,
      search: async (_q: SemanticQuery): Promise<RepoSearchResult[]> => entries.map(e => ({ entry: e, score: 1 })),
      updateStatus: async () => {},
      getVersionHistory: async () => [],
      findByType: async () => [],
      fullTextSearch: async () => [],
      delete: async () => {},
      count: async () => entries.length,
      close: async () => {},
    };

    const repository = new KnowledgeRepository(mockProvider);

    // Use SemanticRelevanceScorer as the scorer via embeddingProvider option
    const injector = new ContextInjector({
      repository,
      scorer: { embeddingProvider: embedding },
    });

    const response = await injector.inject({
      userQuery: 'vector similarity search FAISS',
      tokenBudget: 1000,
    });

    // Should return results with vector DB entry ranked higher
    expect(response.entries.length).toBeGreaterThan(0);
    expect(response.entries[0].entryId).toBe('i1');
  });
});

// ─── Facade: getSemanticScorer + createContextInjector ─────────────────────────

describe('Kivo facade: SemanticRelevanceScorer wiring', () => {
  function makeKivoConfig(withEmbedding: boolean): KivoConfig {
    const base: KivoConfig = { dbPath: ':memory:' };
    if (withEmbedding) {
      base.embedding = { provider: 'local', options: { dimensions: 64 } };
    }
    return base;
  }

  it('getSemanticScorer() returns undefined when embedding not configured', async () => {
    const kivo = new Kivo(makeKivoConfig(false));
    await kivo.init();
    expect(kivo.getSemanticScorer()).toBeUndefined();
    await kivo.shutdown();
  });

  it('getSemanticScorer() returns SemanticRelevanceScorer when embedding configured', async () => {
    const kivo = new Kivo(makeKivoConfig(true));
    await kivo.init();
    const scorer = kivo.getSemanticScorer();
    expect(scorer).toBeDefined();
    expect(scorer).toBeInstanceOf(SemanticRelevanceScorer);
    await kivo.shutdown();
  });

  it('createContextInjector() auto-injects semantic scorer', async () => {
    const kivo = new Kivo(makeKivoConfig(true));
    await kivo.init();

    // Ingest some content so repository has entries
    await kivo.ingest('Vector databases like FAISS enable fast similarity search', 'test-doc');
    await kivo.ingest('SQL databases handle relational queries efficiently', 'test-doc-2');

    const injector = kivo.createContextInjector({
      repository: (kivo as any).repository,
    });

    const response = await injector.inject({
      userQuery: 'vector similarity search',
      tokenBudget: 2000,
    });

    expect(response.entries.length).toBeGreaterThan(0);
    await kivo.shutdown();
  });

  it('getSemanticScorer() result is usable as scorerInstance in ContextInjector', async () => {
    const kivo = new Kivo(makeKivoConfig(true));
    await kivo.init();

    await kivo.ingest('Machine learning uses neural networks for pattern recognition', 'ml-doc');
    await kivo.ingest('Cooking pasta requires boiling water and timing', 'cooking-doc');

    const scorer = kivo.getSemanticScorer()!;
    const injector = new ContextInjector({
      repository: (kivo as any).repository,
      scorerInstance: scorer,
    });

    const response = await injector.inject({
      userQuery: 'neural networks machine learning',
      tokenBudget: 2000,
    });

    expect(response.entries.length).toBeGreaterThan(0);
    await kivo.shutdown();
  });
});
