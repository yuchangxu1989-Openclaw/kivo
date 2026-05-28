import { describe, expect, it } from 'vitest';
import { AssociationEnhancedRetrieval } from '../association-retrieval.js';
import { AssociationStore } from '../association-store.js';
import { clearInsightCaches, computeDynamicThreshold, computeP75Weight } from '../graph-insights.js';
import { buildSnapshot as buildKnowledgeGraphSnapshot } from '../knowledge-graph.js';
import type { KnowledgeEntry } from '../../types/index.js';

function makeEntry(id: string): KnowledgeEntry {
  return {
    id,
    type: 'fact',
    title: `Entry ${id}`,
    content: `Content ${id}`,
    summary: `Summary ${id}`,
    source: { type: 'document', reference: `doc://${id}`, timestamp: new Date('2026-05-01T00:00:00.000Z') },
    confidence: 0.9,
    status: 'active',
    tags: [],
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    version: 1,
  };
}

describe('FR-FIX-09 association enhancement', () => {
  it('computes dynamic threshold and P75 from graph snapshot', () => {
    clearInsightCaches();
    const snapshot = buildKnowledgeGraphSnapshot(
      [makeEntry('a'), makeEntry('b'), makeEntry('c')],
      [
        { sourceId: 'a', targetId: 'b', type: 'supplements', strength: 0.2 },
        { sourceId: 'b', targetId: 'c', type: 'depends_on', strength: 0.8 },
      ],
      new Date('2026-05-01T00:00:00.000Z'),
    );

    expect(computeDynamicThreshold(snapshot)).toBeGreaterThanOrEqual(0.2);
    expect(computeP75Weight(snapshot)).toBe(0.8);
  });

  it('downweights associations below P75 during enhancement', async () => {
    clearInsightCaches();
    const store = new AssociationStore();
    store.add({ sourceId: 'entry-a', targetId: 'entry-b', type: 'supplements', strength: 0.2 });
    store.add({ sourceId: 'entry-a', targetId: 'entry-c', type: 'depends_on', strength: 0.9 });

    const entries = new Map([
      ['entry-b', makeEntry('entry-b')],
      ['entry-c', makeEntry('entry-c')],
    ]);
    const repository = {
      async findById(id: string) {
        return entries.get(id) ?? null;
      },
    } as { findById(id: string): Promise<KnowledgeEntry | null> };

    const retrieval = new AssociationEnhancedRetrieval(repository as never, store);
    const enhanced = await retrieval.enhance([
      { entry: makeEntry('entry-a'), score: 1 },
    ], { minAssociationStrength: 0.1 });

    expect(enhanced[0].associatedEntries).toHaveLength(2);
    const weak = enhanced[0].associatedEntries.find((entry) => entry.entry.id === 'entry-b');
    const strong = enhanced[0].associatedEntries.find((entry) => entry.entry.id === 'entry-c');
    expect(weak?.weightTier).toBe('downweighted');
    expect(strong?.weightTier).toBe('normal');
    expect((weak?.weightScore ?? 0)).toBeLessThan((strong?.weightScore ?? 0));
  });
});
