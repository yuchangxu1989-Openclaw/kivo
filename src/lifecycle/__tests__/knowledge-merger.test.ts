import { beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeMerger } from '../knowledge-merger.js';
import { MemoryKnowledgeStore } from '../../storage/index.js';
import type { KnowledgeEntry, KnowledgeSource } from '../../types/index.js';

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

describe('KnowledgeMerger', () => {
  let store: MemoryKnowledgeStore;
  let merger: KnowledgeMerger;

  beforeEach(() => {
    store = new MemoryKnowledgeStore();
    merger = new KnowledgeMerger({
      store,
      now: () => new Date('2026-04-20T12:00:00.000Z'),
      idGenerator: () => 'merged-entry-1',
    });
  });

  it('finds merge candidates for same-topic entries from different sources', async () => {
    const entries = [
      makeEntry({
        id: 'entry-1',
        source: testSource('doc://strict-mode-guide'),
        content: 'Strict mode catches unsafe implicit any usage.',
        summary: 'Type safety benefits',
      }),
      makeEntry({
        id: 'entry-2',
        source: testSource('doc://strict-mode-migration'),
        content: 'Strict mode also improves null safety during migrations.',
        summary: 'Migration and null safety',
      }),
    ];

    const candidates = merger.findMergeCandidates(entries);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        sourceEntryIds: ['entry-1', 'entry-2'],
        topic: 'typescript strict mode',
      })
    );
    expect(candidates[0].similarity).toBeGreaterThan(0.6);
  });

  it('merges entries and preserves all source references', async () => {
    await store.save(
      makeEntry({
        id: 'entry-1',
        source: testSource('doc://strict-mode-guide'),
        content: 'Strict mode catches unsafe implicit any usage.',
        summary: 'Type safety benefits',
      })
    );
    await store.save(
      makeEntry({
        id: 'entry-2',
        source: testSource('doc://strict-mode-migration'),
        content: 'Strict mode also improves null safety during migrations.',
        summary: 'Migration and null safety',
      })
    );

    const merged = await merger.merge({
      sourceEntryIds: ['entry-1', 'entry-2'],
      topic: 'typescript strict mode',
      similarity: 0.82,
    });

    expect(merged.id).toBe('merged-entry-1');
    expect(merged.reversible).toBe(true);
    expect(merged.sourceRefs).toHaveLength(2);
    expect(merged.sourceRefs.map((ref) => ref.entryId)).toEqual(['entry-1', 'entry-2']);
    expect(merged.content).toContain('implicit any');
    expect(merged.content).toContain('null safety');

    const mergedInStore = await store.get('merged-entry-1');
    expect(mergedInStore).not.toBeNull();

    const originalOne = await store.get('entry-1');
    const originalTwo = await store.get('entry-2');
    expect(originalOne?.status).toBe('superseded');
    expect(originalTwo?.status).toBe('superseded');
  });

  it('reverts a merged entry and restores original entries', async () => {
    await store.save(
      makeEntry({
        id: 'entry-1',
        source: testSource('doc://strict-mode-guide'),
      })
    );
    await store.save(
      makeEntry({
        id: 'entry-2',
        source: testSource('doc://strict-mode-migration'),
        content: 'Strict mode also improves null safety during migrations.',
      })
    );

    await merger.merge({
      sourceEntryIds: ['entry-1', 'entry-2'],
      topic: 'typescript strict mode',
      similarity: 0.82,
    });

    const reversal = await merger.revert('merged-entry-1');

    expect(reversal).toEqual({
      mergedEntryId: 'merged-entry-1',
      restoredEntryIds: ['entry-1', 'entry-2'],
      reversedAt: new Date('2026-04-20T12:00:00.000Z'),
    });

    const mergedInStore = await store.get('merged-entry-1');
    expect(mergedInStore).toBeNull();
    expect((await store.get('entry-1'))?.status).toBe('active');
    expect((await store.get('entry-2'))?.status).toBe('active');

    const history = merger.getMergeHistory();
    expect(history.merged).toHaveLength(0);
    expect(history.reversals).toHaveLength(1);
  });

  it('skips when no merge candidates exist', () => {
    const entries = [
      makeEntry({
        id: 'entry-1',
        title: 'TypeScript strict mode',
        source: testSource('doc://strict-mode-guide'),
      }),
      makeEntry({
        id: 'entry-2',
        title: 'React hooks',
        source: testSource('doc://react-hooks-guide'),
        content: 'Hooks help compose stateful logic.',
        summary: 'Hooks overview',
      }),
    ];

    const candidates = merger.findMergeCandidates(entries);

    expect(candidates).toEqual([]);
  });

  it('does not merge contradictory entries', () => {
    const entries = [
      makeEntry({
        id: 'entry-1',
        title: 'Deletion approval policy',
        content: 'Agents must ask for user confirmation before deleting files.',
        summary: 'Deletion requires confirmation',
        source: testSource('doc://policy-a'),
      }),
      makeEntry({
        id: 'entry-2',
        title: 'Deletion approval policy',
        content: 'Agents must not ask for user confirmation before deleting files.',
        summary: 'Deletion does not require confirmation',
        source: testSource('doc://policy-b'),
      }),
    ];

    const candidates = merger.findMergeCandidates(entries);

    expect(candidates).toEqual([]);
  });
});
