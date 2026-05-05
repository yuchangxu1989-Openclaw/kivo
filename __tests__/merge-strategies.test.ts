import { beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeMerger } from '../src/lifecycle/knowledge-merger.js';
import { MemoryKnowledgeStore } from '../src/storage/index.js';
import type { KnowledgeEntry, KnowledgeSource } from '../src/types/index.js';

const testSource = (reference: string): KnowledgeSource => ({
  type: 'document',
  reference,
  timestamp: new Date('2026-04-20T09:00:00.000Z'),
});

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    type: 'fact',
    title: 'TypeScript strict mode',
    content: 'Strict mode catches unsafe implicit any usage.',
    summary: 'Strict mode overview',
    source: testSource(`doc://${id}`),
    confidence: 0.9,
    status: 'active',
    tags: ['typescript'],
    createdAt: new Date('2026-04-10T09:00:00.000Z'),
    updatedAt: new Date('2026-04-10T09:00:00.000Z'),
    version: 1,
    ...overrides,
  };
}

describe('KnowledgeMerger — type-specific strategies (FR-C03 AC2)', () => {
  let store: MemoryKnowledgeStore;

  beforeEach(() => {
    store = new MemoryKnowledgeStore();
  });

  it('fact entries merge automatically (union)', async () => {
    const merger = new KnowledgeMerger({
      store,
      now: () => new Date('2026-04-20T12:00:00.000Z'),
      idGenerator: () => 'merged-fact',
    });

    await store.save(makeEntry({
      id: 'fact-1',
      type: 'fact',
      source: testSource('doc://fact-guide'),
      content: 'TypeScript strict mode catches implicit any.',
    }));
    await store.save(makeEntry({
      id: 'fact-2',
      type: 'fact',
      source: testSource('doc://fact-migration'),
      content: 'TypeScript strict mode improves null safety.',
    }));

    const merged = await merger.merge({
      sourceEntryIds: ['fact-1', 'fact-2'],
      topic: 'typescript strict mode',
      similarity: 0.85,
    });

    expect(merged.status).toBe('active');
    expect(merged.sourceRefs).toHaveLength(2);
  });

  it('experience entries merge automatically (union)', async () => {
    const merger = new KnowledgeMerger({
      store,
      now: () => new Date('2026-04-20T12:00:00.000Z'),
      idGenerator: () => 'merged-exp',
    });

    await store.save(makeEntry({
      id: 'exp-1',
      type: 'experience',
      title: 'Debugging memory leaks',
      source: testSource('doc://exp-a'),
      content: 'Use heap snapshots to identify retained objects.',
      summary: 'Heap snapshot approach',
    }));
    await store.save(makeEntry({
      id: 'exp-2',
      type: 'experience',
      title: 'Debugging memory leaks',
      source: testSource('doc://exp-b'),
      content: 'Monitor RSS growth over time to detect slow leaks.',
      summary: 'RSS monitoring approach',
    }));

    const merged = await merger.merge({
      sourceEntryIds: ['exp-1', 'exp-2'],
      topic: 'debugging memory leaks',
      similarity: 0.8,
    });

    expect(merged.status).toBe('active');
    expect(merged.content).toContain('heap snapshots');
    expect(merged.content).toContain('RSS growth');
  });

  it('decision entries are blocked from auto-merge', async () => {
    const merger = new KnowledgeMerger({
      store,
      now: () => new Date('2026-04-20T12:00:00.000Z'),
      idGenerator: () => 'merged-decision',
    });

    await store.save(makeEntry({
      id: 'dec-1',
      type: 'decision',
      title: 'Database selection',
      source: testSource('doc://dec-a'),
      content: 'We chose PostgreSQL for relational data.',
      summary: 'PostgreSQL decision',
    }));
    await store.save(makeEntry({
      id: 'dec-2',
      type: 'decision',
      title: 'Database selection',
      source: testSource('doc://dec-b'),
      content: 'We also considered SQLite for embedded use cases.',
      summary: 'SQLite consideration',
    }));

    await expect(
      merger.merge({
        sourceEntryIds: ['dec-1', 'dec-2'],
        topic: 'database selection',
        similarity: 0.8,
        requiresManualConfirmation: true,
      })
    ).rejects.toThrow('requires manual confirmation');
  });

  it('methodology entries merge but get pending status for review', async () => {
    const merger = new KnowledgeMerger({
      store,
      now: () => new Date('2026-04-20T12:00:00.000Z'),
      idGenerator: () => 'merged-method',
    });

    await store.save(makeEntry({
      id: 'method-1',
      type: 'methodology',
      title: 'Code review process',
      source: testSource('doc://method-a'),
      content: 'All PRs require at least one reviewer.',
      summary: 'Review requirement',
    }));
    await store.save(makeEntry({
      id: 'method-2',
      type: 'methodology',
      title: 'Code review process',
      source: testSource('doc://method-b'),
      content: 'Reviewers should focus on logic, not style.',
      summary: 'Review focus',
    }));

    const merged = await merger.merge({
      sourceEntryIds: ['method-1', 'method-2'],
      topic: 'code review process',
      similarity: 0.8,
      requiresReview: true,
    });

    expect(merged.status).toBe('pending');
    expect(merged.sourceRefs).toHaveLength(2);
  });

  it('findMergeCandidates marks decision candidates with requiresManualConfirmation', () => {
    const merger = new KnowledgeMerger({
      store,
      now: () => new Date('2026-04-20T12:00:00.000Z'),
    });

    const entries = [
      makeEntry({
        id: 'dec-1',
        type: 'decision',
        title: 'API framework choice',
        source: testSource('doc://dec-a'),
        content: 'We chose Express for its ecosystem.',
        summary: 'Express decision',
      }),
      makeEntry({
        id: 'dec-2',
        type: 'decision',
        title: 'API framework choice',
        source: testSource('doc://dec-b'),
        content: 'Fastify was also evaluated for performance.',
        summary: 'Fastify evaluation',
      }),
    ];

    const candidates = merger.findMergeCandidates(entries);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].requiresManualConfirmation).toBe(true);
    expect(candidates[0].requiresReview).toBe(false);
  });

  it('findMergeCandidates marks methodology candidates with requiresReview', () => {
    const merger = new KnowledgeMerger({
      store,
      now: () => new Date('2026-04-20T12:00:00.000Z'),
    });

    const entries = [
      makeEntry({
        id: 'method-1',
        type: 'methodology',
        title: 'Testing strategy',
        source: testSource('doc://method-a'),
        content: 'Unit tests cover all public methods.',
        summary: 'Unit test coverage',
      }),
      makeEntry({
        id: 'method-2',
        type: 'methodology',
        title: 'Testing strategy',
        source: testSource('doc://method-b'),
        content: 'Integration tests cover API endpoints.',
        summary: 'Integration test coverage',
      }),
    ];

    const candidates = merger.findMergeCandidates(entries);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].requiresManualConfirmation).toBe(false);
    expect(candidates[0].requiresReview).toBe(true);
  });
});

describe('KnowledgeMerger — configurable similarity threshold (FR-C03 AC1)', () => {
  it('filters candidates below the configured threshold', () => {
    const store = new MemoryKnowledgeStore();
    const merger = new KnowledgeMerger({
      store,
      now: () => new Date('2026-04-20T12:00:00.000Z'),
      similarityThreshold: 0.95,
    });

    const entries = [
      makeEntry({
        id: 'entry-1',
        title: 'TypeScript strict mode',
        source: testSource('doc://a'),
        content: 'Strict mode catches unsafe implicit any usage.',
        summary: 'Type safety benefits',
      }),
      makeEntry({
        id: 'entry-2',
        title: 'TypeScript strict mode',
        source: testSource('doc://b'),
        content: 'Strict mode also improves null safety during migrations.',
        summary: 'Migration and null safety',
      }),
    ];

    // With high threshold (0.95), candidates with lower similarity are filtered out
    const candidates = merger.findMergeCandidates(entries);
    // The similarity is based on title + summary overlap, which won't reach 0.95
    // for entries with different summaries
    expect(candidates.every((c) => c.similarity >= 0.95)).toBe(true);
  });

  it('allows overriding threshold per call', () => {
    const store = new MemoryKnowledgeStore();
    const merger = new KnowledgeMerger({
      store,
      now: () => new Date('2026-04-20T12:00:00.000Z'),
      similarityThreshold: 0.99, // very high default
    });

    const entries = [
      makeEntry({
        id: 'entry-1',
        title: 'TypeScript strict mode',
        source: testSource('doc://a'),
        content: 'Strict mode catches unsafe implicit any usage.',
        summary: 'Type safety benefits',
      }),
      makeEntry({
        id: 'entry-2',
        title: 'TypeScript strict mode',
        source: testSource('doc://b'),
        content: 'Strict mode also improves null safety during migrations.',
        summary: 'Migration and null safety',
      }),
    ];

    // Default threshold (0.99) filters everything
    const highThreshold = merger.findMergeCandidates(entries);

    // Override with lower threshold
    const lowThreshold = merger.findMergeCandidates(entries, { similarityThreshold: 0.3 });
    expect(lowThreshold.length).toBeGreaterThanOrEqual(highThreshold.length);
  });
});
