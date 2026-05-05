import { describe, expect, it } from 'vitest';
import { KnowledgeRouter } from '../knowledge-router.js';
import type { KnowledgeEntry, KnowledgeSource } from '../../types/index.js';

function makeSource(): KnowledgeSource {
  return { type: 'document', reference: 'doc://test', timestamp: new Date('2026-05-01T00:00:00Z') };
}

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: 'e-1',
    type: 'fact',
    title: 'Test Entry',
    content: 'content',
    summary: 'summary',
    source: makeSource(),
    confidence: 0.9,
    status: 'active',
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

describe('KnowledgeRouter — category routing rule matching', () => {
  it('routes entry with category to correct pipeline', () => {
    const router = new KnowledgeRouter();
    const entry = makeEntry({ category: 'domain' });
    const decision = router.route(entry);

    expect(decision.pipeline).toBe('standard');
    expect(decision.injectionPriority).toBe(10);
  });

  it('routes analysis category to deep-analysis pipeline', () => {
    const router = new KnowledgeRouter();
    const entry = makeEntry({ category: 'analysis' });
    const decision = router.route(entry);

    expect(decision.pipeline).toBe('deep-analysis');
    expect(decision.injectionPriority).toBe(7);
  });

  it('routes tool category to fast-index pipeline', () => {
    const router = new KnowledgeRouter();
    const entry = makeEntry({ category: 'tool' });
    const decision = router.route(entry);

    expect(decision.pipeline).toBe('fast-index');
    expect(decision.conflictStrategy).toBe('skip');
  });

  it('resolvePipeline returns standard for entry without category', () => {
    const router = new KnowledgeRouter();
    const entry = makeEntry(); // no category
    expect(router.resolvePipeline(entry)).toBe('standard');
  });

  it('custom categoryRules override defaults', () => {
    const router = new KnowledgeRouter({
      categoryRules: [
        { category: 'domain', pipeline: 'custom-pipeline', conflictStrategy: 'relaxed', injectionPriority: 99 },
      ],
    });
    const entry = makeEntry({ category: 'domain' });
    const decision = router.route(entry);

    expect(decision.pipeline).toBe('custom-pipeline');
    expect(decision.conflictStrategy).toBe('relaxed');
    expect(decision.injectionPriority).toBe(99);
  });
});

describe('KnowledgeRouter — category overrides type (conflictStrategy)', () => {
  it('category conflictStrategy overrides type conflictStrategy', () => {
    // Default: fact type has conflictStrategy='strict'
    // Default: tool category has conflictStrategy='skip'
    const router = new KnowledgeRouter();
    const entry = makeEntry({ type: 'fact', category: 'tool' });
    const decision = router.route(entry);

    // Category rule should win over type rule
    expect(decision.conflictStrategy).toBe('skip');
  });

  it('falls back to type conflictStrategy when no category rule exists', () => {
    const router = new KnowledgeRouter();
    const entry = makeEntry({ type: 'methodology' }); // no category
    const decision = router.route(entry);

    expect(decision.conflictStrategy).toBe('relaxed'); // from type rule
    expect(decision.pipeline).toBeUndefined(); // no category rule matched
  });

  it('category persistenceRule overrides type persistenceRule', () => {
    const router = new KnowledgeRouter({
      categoryRules: [
        { category: 'meta', pipeline: 'fast-index', persistenceRule: 'review_required' },
      ],
    });
    const entry = makeEntry({ type: 'meta', category: 'meta', confidence: 0.9 });
    const decision = router.route(entry);

    // meta type default persistenceRule is 'auto', but category override says 'review_required'
    expect(decision.persistenceRule).toBe('review_required');
  });
});
