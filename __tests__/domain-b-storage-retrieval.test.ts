import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryKnowledgeStore } from '../src/storage/index.js';
import { AssociationStore } from '../src/association/index.js';
import { EmbeddingCache, LocalEmbedding } from '../src/embedding/index.js';
import { KnowledgeSearch, MockEmbeddingAdapter } from '../src/search/knowledge-search.js';
import { DomainGoalStore } from '../src/domain-goal/domain-goal-store.js';
import type { KnowledgeEntry, KnowledgeSource } from '../src/types/index.js';

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'test://domain-b-coverage',
  timestamp: new Date('2026-04-29T09:00:00.000Z'),
  agent: 'dev-01',
};

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = overrides.createdAt ?? new Date('2026-04-29T09:00:00.000Z');
  const updatedAt = overrides.updatedAt ?? new Date(createdAt.getTime());

  return {
    id,
    type: 'fact',
    title: `title-${id}`,
    content: `content-${id}`,
    summary: `summary-${id}`,
    source: overrides.source ?? testSource,
    confidence: 0.85,
    status: 'active',
    tags: ['core'],
    domain: 'knowledge',
    createdAt,
    updatedAt,
    version: 1,
    ...overrides,
  };
}

describe('Domain B coverage', () => {
  describe('FR-B01: structured knowledge storage', () => {
    let store: MemoryKnowledgeStore;

    beforeEach(() => {
      store = new MemoryKnowledgeStore();
    });

    it('stores required fields, supported statuses, metadata extensions, and version history', async () => {
      const entry = makeEntry({
        id: 'b01',
        status: 'pending',
        metadata: {
          referenceCount: 2,
          externalValid: true,
          domainData: { schema: 'domain-b', topic: 'retrieval' },
          embedding: {
            status: 'pending_rebuild',
            contentHash: 'hash-v1',
            error: 'provider timeout',
            updatedAt: new Date('2026-04-29T09:00:00.000Z'),
          },
        },
      });

      const saved = await store.save(entry);
      expect(saved.id).toBe('b01');
      expect(saved.type).toBe('fact');
      expect(saved.content).toContain('content');
      expect(saved.source.reference).toBe(testSource.reference);
      expect(saved.createdAt).toBeInstanceOf(Date);
      expect(saved.updatedAt).toBeInstanceOf(Date);
      expect(saved.version).toBe(1);
      expect(saved.status).toBe('pending');
      expect(saved.domain).toBe('knowledge');
      expect(saved.metadata?.domainData).toEqual({ schema: 'domain-b', topic: 'retrieval' });
      expect(saved.metadata?.embedding?.status).toBe('pending_rebuild');

      await store.update('b01', {
        content: 'updated content',
        status: 'superseded',
        metadata: {
          embedding: {
            status: 'ready',
            contentHash: 'hash-v2',
            modelId: 'local-bow',
            dimensions: 384,
            updatedAt: new Date('2026-04-29T09:10:00.000Z'),
          },
        },
      });

      await store.update('b01', {
        status: 'archived',
        metadata: {
          archivedAt: new Date('2026-04-30T09:00:00.000Z'),
        },
      });

      const history = await store.getVersionHistory('b01');
      expect(history.map((item) => item.version)).toEqual([1, 2, 3]);
      expect(history[0].metadata?.embedding?.status).toBe('pending_rebuild');
      expect(history[1].metadata?.embedding?.status).toBe('ready');
      expect(history[2].status).toBe('archived');
    });

    it('filters by source and time range', async () => {
      await store.saveMany([
        makeEntry({
          id: 'f1',
          source: { ...testSource, type: 'manual', reference: 'manual://guide' },
          createdAt: new Date('2026-04-01T09:00:00.000Z'),
          updatedAt: new Date('2026-04-01T10:00:00.000Z'),
        }),
        makeEntry({
          id: 'f2',
          source: { ...testSource, type: 'document', reference: 'docs://kivo/spec' },
          createdAt: new Date('2026-04-10T09:00:00.000Z'),
          updatedAt: new Date('2026-04-10T10:00:00.000Z'),
        }),
        makeEntry({
          id: 'f3',
          source: { ...testSource, type: 'research', reference: 'research://gap-report' },
          createdAt: new Date('2026-04-20T09:00:00.000Z'),
          updatedAt: new Date('2026-04-20T10:00:00.000Z'),
        }),
      ]);

      const bySourceType = await store.query({ source: 'document' });
      expect(bySourceType.items.map((item) => item.id)).toEqual(['f2']);

      const bySourceReference = await store.query({ source: 'research://gap-report' });
      expect(bySourceReference.items.map((item) => item.id)).toEqual(['f3']);

      const byCreatedAt = await store.query({
        createdAt: {
          from: new Date('2026-04-05T00:00:00.000Z'),
          to: new Date('2026-04-15T23:59:59.000Z'),
        },
      });
      expect(byCreatedAt.items.map((item) => item.id)).toEqual(['f2']);

      const byUpdatedAt = await store.query({
        updatedAt: {
          from: new Date('2026-04-19T00:00:00.000Z'),
          to: new Date('2026-04-21T23:59:59.000Z'),
        },
      });
      expect(byUpdatedAt.items.map((item) => item.id)).toEqual(['f3']);
    });
  });

  describe('FR-B02 + FR-B03: semantic retrieval and associations', () => {
    let store: MemoryKnowledgeStore;

    beforeEach(async () => {
      store = new MemoryKnowledgeStore();
      await store.saveMany([
        makeEntry({
          id: 'search-1',
          type: 'fact',
          domain: 'ai',
          title: 'Embedding cache strategy',
          content: 'Embedding cache prevents duplicate vector generation and speeds up retrieval.',
          summary: 'cache strategy for embeddings',
          tags: ['embedding', 'cache'],
          source: { ...testSource, type: 'document', reference: 'docs://embedding' },
          createdAt: new Date('2026-04-10T09:00:00.000Z'),
          updatedAt: new Date('2026-04-10T09:00:00.000Z'),
        }),
        makeEntry({
          id: 'search-2',
          type: 'decision',
          domain: 'ai',
          title: 'Domain goal ranking',
          content: 'Search ranking should prioritize entries aligned with retrieval coverage questions.',
          summary: 'ranking aligned with domain goals',
          tags: ['search', 'ranking'],
          source: { ...testSource, type: 'manual', reference: 'manual://ranking' },
          createdAt: new Date('2026-04-12T09:00:00.000Z'),
          updatedAt: new Date('2026-04-12T09:00:00.000Z'),
        }),
        makeEntry({
          id: 'search-3',
          type: 'methodology',
          domain: 'ops',
          title: 'Incident postmortem',
          content: 'Run a postmortem after every production failure.',
          summary: 'ops methodology',
          tags: ['ops'],
          source: { ...testSource, type: 'research', reference: 'research://incident' },
          createdAt: new Date('2026-04-18T09:00:00.000Z'),
          updatedAt: new Date('2026-04-18T09:00:00.000Z'),
        }),
      ]);
    });

    it('supports filters by type, domain, source, and time range', async () => {
      const search = new KnowledgeSearch(store, new MockEmbeddingAdapter());

      const factResults = await search.search('embedding vector', { type: 'fact' });
      expect(factResults.every((result) => result.entry.type === 'fact')).toBe(true);

      const domainResults = await search.search('ranking retrieval', { domain: 'ai' });
      expect(domainResults.every((result) => result.entry.domain === 'ai')).toBe(true);

      const sourceResults = await search.search('ranking retrieval', { source: 'manual' });
      expect(sourceResults.map((result) => result.entry.id)).toContain('search-2');
      expect(sourceResults.every((result) => result.entry.source.type === 'manual')).toBe(true);

      const timeFiltered = await search.search('incident production', {
        updatedAt: {
          from: new Date('2026-04-17T00:00:00.000Z'),
          to: new Date('2026-04-19T00:00:00.000Z'),
        },
      });
      expect(timeFiltered.map((result) => result.entry.id)).toEqual(['search-3']);
    });

    it('boosts ranking when a domain goal exists for the queried domain', async () => {
      const goalStore = new DomainGoalStore();
      goalStore.create({
        domainId: 'ai',
        purpose: 'AI retrieval quality',
        keyQuestions: ['How to improve retrieval coverage', 'How to avoid duplicate embedding generation'],
        nonGoals: ['UI polish'],
        researchBoundary: 'Only knowledge retrieval and indexing topics',
        prioritySignals: ['retrieval', 'embedding', 'coverage'],
      });

      const plainSearch = new KnowledgeSearch(store, new MockEmbeddingAdapter());
      const boostedSearch = new KnowledgeSearch(store, new MockEmbeddingAdapter(), {
        domainGoalStore: goalStore,
      });

      const plainResults = await plainSearch.search('improve retrieval coverage', { domain: 'ai' });
      const boostedResults = await boostedSearch.search('improve retrieval coverage', { domain: 'ai' });

      expect(boostedResults.length).toBeGreaterThan(0);

      const plainTarget = plainResults.find((result) => result.entry.id === 'search-2');
      const boostedTarget = boostedResults.find((result) => result.entry.id === 'search-2');

      expect(plainTarget).toBeDefined();
      expect(boostedTarget).toBeDefined();
      expect(boostedTarget!.relevance).toBeGreaterThan(plainTarget!.relevance);
      expect(boostedTarget!.domainGoalMatchedQuestions?.length).toBeGreaterThan(0);
    });

    it('uses associations to improve result completeness', async () => {
      const associationStore = new AssociationStore();
      associationStore.add({
        sourceId: 'search-1',
        targetId: 'search-2',
        type: 'supplements',
        strength: 0.9,
      });

      const search = new KnowledgeSearch(store, new MockEmbeddingAdapter(), {
        associationStore,
        includeAssociated: true,
      });

      const results = await search.search('embedding cache');
      const ids = results.map((result) => result.entry.id);
      expect(ids).toContain('search-1');
      expect(ids).toContain('search-2');
    });
  });

  describe('FR-B04: embedding generation and cache', () => {
    it('caches duplicate content and refreshes on content change', async () => {
      const provider = new LocalEmbedding(64);
      const spy = vi.spyOn(provider, 'embed');
      const cache = new EmbeddingCache(provider, 10);

      const v1 = await cache.embed('same content');
      const v2 = await cache.embed('same content');
      const v3 = await cache.embed('changed content');

      expect(v1).toEqual(v2);
      expect(v3).not.toEqual(v1);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, size: 2 });
    });

    it('degrades to metadata-filtered keyword retrieval when embedding provider fails', async () => {
      const store = new MemoryKnowledgeStore();
      await store.save(
        makeEntry({
          id: 'fallback-1',
          domain: 'ai',
          type: 'fact',
          source: { ...testSource, type: 'document', reference: 'docs://fallback' },
          title: 'Redis cache fallback',
          content: 'Redis fallback supports keyword retrieval when semantic embeddings fail.',
          summary: 'fallback retrieval',
          tags: ['redis', 'fallback'],
        })
      );

      const failingAdapter = {
        embed: vi.fn().mockRejectedValue(new Error('provider unavailable')),
      };

      const search = new KnowledgeSearch(store, failingAdapter);
      const results = await search.search('Redis fallback', {
        domain: 'ai',
        type: 'fact',
        source: 'document',
      });

      expect(results.length).toBe(1);
      expect(results[0].entry.id).toBe('fallback-1');
    });
  });
});
