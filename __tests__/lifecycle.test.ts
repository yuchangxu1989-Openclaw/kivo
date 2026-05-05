import { beforeEach, describe, expect, it } from 'vitest';
import { CleanupManager, ExpiryDetector } from '../src/lifecycle/index.js';
import { MemoryKnowledgeStore } from '../src/storage/index.js';
import type { KnowledgeEntry, KnowledgeSource } from '../src/types/index.js';

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'test://lifecycle',
  timestamp: new Date('2026-04-20T09:00:00.000Z'),
  agent: 'dev-01',
};

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = overrides.createdAt ?? new Date('2026-04-01T09:00:00.000Z');
  const updatedAt = overrides.updatedAt ?? new Date(createdAt);

  return {
    id,
    type: 'fact',
    title: `title-${id}`,
    content: `content-${id}`,
    summary: `summary-${id}`,
    source: testSource,
    confidence: 0.9,
    status: 'active',
    tags: ['core'],
    createdAt,
    updatedAt,
    version: 1,
    metadata: {
      referenceCount: 5,
      externalValid: true,
    },
    ...overrides,
  };
}

describe('ExpiryDetector', () => {
  it('detects time decay based on updatedAt age', () => {
    const detector = new ExpiryDetector({
      now: () => new Date('2026-04-20T09:00:00.000Z'),
    });

    const results = detector.detect(
      [
        makeEntry({
          id: 'stale',
          updatedAt: new Date('2026-03-01T09:00:00.000Z'),
          metadata: { referenceCount: 10, externalValid: true },
        }),
      ],
      { maxAgeDays: 7, minReferenceCount: 1 }
    );

    expect(results).toHaveLength(1);
    expect(results[0].entry.id).toBe('stale');
    expect(results[0].reasons).toContain('time_decay');
  });

  it('detects low reference count', () => {
    const detector = new ExpiryDetector({
      now: () => new Date('2026-04-20T09:00:00.000Z'),
    });

    const results = detector.detect(
      [
        makeEntry({
          id: 'low-ref',
          updatedAt: new Date('2026-04-19T09:00:00.000Z'),
          metadata: { referenceCount: 0, externalValid: true },
        }),
      ],
      { maxAgeDays: 30, minReferenceCount: 2 }
    );

    expect(results).toHaveLength(1);
    expect(results[0].reasons).toContain('low_reference');
  });

  it('detects external invalidation when policy enables external validation', () => {
    const detector = new ExpiryDetector({
      now: () => new Date('2026-04-20T09:00:00.000Z'),
    });

    const results = detector.detect(
      [
        makeEntry({
          id: 'invalidated',
          metadata: { referenceCount: 10, externalValid: false },
        }),
      ],
      { maxAgeDays: 30, minReferenceCount: 1, externalValidation: true }
    );

    expect(results).toHaveLength(1);
    expect(results[0].reasons).toContain('external_invalidation');
  });
});

describe('CleanupManager', () => {
  let store: MemoryKnowledgeStore;

  beforeEach(() => {
    store = new MemoryKnowledgeStore();
  });

  it('marks entries as deprecated without deleting them', async () => {
    await store.save(makeEntry({ id: 'deprecated-me' }));
    const manager = new CleanupManager({
      store,
      now: () => new Date('2026-04-20T10:00:00.000Z'),
    });

    await manager.markDeprecated(['deprecated-me']);

    const entry = await store.get('deprecated-me');
    expect(entry).not.toBeNull();
    expect(entry?.status).toBe('deprecated');
    expect(entry?.metadata?.deprecatedAt).toEqual(new Date('2026-04-20T10:00:00.000Z'));
  });

  it('archives deprecated entries after cleanup cycle', async () => {
    await store.save(
      makeEntry({
        id: 'archive-me',
        status: 'deprecated',
        metadata: {
          referenceCount: 0,
          externalValid: true,
          deprecatedAt: new Date('2026-03-01T09:00:00.000Z'),
        },
        updatedAt: new Date('2026-03-01T09:00:00.000Z'),
      })
    );

    const manager = new CleanupManager({
      store,
      now: () => new Date('2026-04-20T10:00:00.000Z'),
    });

    await manager.archive(['archive-me']);

    const entry = await store.get('archive-me');
    expect(entry?.status).toBe('archived');
    expect(entry?.metadata?.archivedAt).toEqual(new Date('2026-04-20T10:00:00.000Z'));
  });

  it('generates cleanup report for deprecated and archived entries', async () => {
    await store.save(
      makeEntry({
        id: 'old-active',
        updatedAt: new Date('2026-03-01T09:00:00.000Z'),
        metadata: { referenceCount: 0, externalValid: true },
      })
    );
    await store.save(
      makeEntry({
        id: 'old-deprecated',
        status: 'deprecated',
        updatedAt: new Date('2026-02-01T09:00:00.000Z'),
        metadata: {
          referenceCount: 0,
          externalValid: false,
          deprecatedAt: new Date('2026-03-01T09:00:00.000Z'),
        },
      })
    );

    const manager = new CleanupManager({
      store,
      now: () => new Date('2026-04-20T10:00:00.000Z'),
    });

    const report = await manager.cleanup({
      maxAgeDays: 7,
      minReferenceCount: 1,
      externalValidation: true,
    });

    expect(report.cleanedAt).toEqual(new Date('2026-04-20T10:00:00.000Z'));
    expect(report.summary.deprecated).toBeGreaterThan(0);
    expect(report.summary.archived).toBeGreaterThan(0);
    expect(report.summary.total).toBe(report.entries.length);
    expect(report.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          knowledgeId: 'old-active',
          action: 'deprecated',
          reason: 'time_decay',
          previousStatus: 'active',
        }),
        expect.objectContaining({
          knowledgeId: 'old-active',
          action: 'deprecated',
          reason: 'low_reference',
          previousStatus: 'active',
        }),
        expect.objectContaining({
          knowledgeId: 'old-deprecated',
          action: 'archived',
          previousStatus: 'deprecated',
        }),
      ])
    );

    const activeEntry = await store.get('old-active');
    const archivedEntry = await store.get('old-deprecated');
    expect(activeEntry?.status).toBe('deprecated');
    expect(archivedEntry?.status).toBe('archived');
  });
});
