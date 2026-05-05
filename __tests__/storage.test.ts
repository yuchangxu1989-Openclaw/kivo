import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryKnowledgeStore } from '../src/storage/index.js';
import type { KnowledgeEntry, KnowledgeSource } from '../src/types/index.js';

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'test://storage',
  timestamp: new Date('2026-04-20T09:00:00.000Z'),
  agent: 'dev-01',
};

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = overrides.createdAt ?? new Date('2026-04-20T09:00:00.000Z');
  const updatedAt = overrides.updatedAt ?? new Date(createdAt.getTime());

  return {
    id,
    type: 'fact',
    title: `title-${id}`,
    content: `content-${id}`,
    summary: `summary-${id}`,
    source: testSource,
    confidence: 0.8,
    status: 'active',
    tags: ['core'],
    domain: 'product',
    createdAt,
    updatedAt,
    version: 1,
    ...overrides,
  };
}

describe('MemoryKnowledgeStore', () => {
  let store: MemoryKnowledgeStore;

  beforeEach(() => {
    store = new MemoryKnowledgeStore();
  });

  it('supports CRUD operations', async () => {
    const created = makeEntry({ id: 'k1' });
    await store.save(created);

    const found = await store.get('k1');
    expect(found).not.toBeNull();
    expect(found?.title).toBe(created.title);
    expect(found?.version).toBe(1);

    const updated = await store.update('k1', {
      title: 'updated title',
      content: 'updated content',
      status: 'pending',
      confidence: 0.42,
      tags: ['core', 'updated'],
      domain: 'engineering',
    });

    expect(updated).not.toBeNull();
    expect(updated?.title).toBe('updated title');
    expect(updated?.status).toBe('pending');
    expect(updated?.confidence).toBe(0.42);
    expect(updated?.tags).toEqual(['core', 'updated']);
    expect(updated?.domain).toBe('engineering');
    expect(updated?.version).toBe(2);

    expect(await store.delete('k1')).toBe(true);
    expect(await store.get('k1')).toBeNull();
    expect(await store.delete('k1')).toBe(false);
  });

  it('returns null when updating a missing entry', async () => {
    const updated = await store.update('missing', { title: 'noop' });
    expect(updated).toBeNull();
  });

  it('filters by type, domain, tags, status, and confidence range', async () => {
    await store.saveMany([
      makeEntry({
        id: 'f1',
        type: 'fact',
        domain: 'analytics',
        tags: ['metrics', 'daily'],
        confidence: 0.92,
        status: 'active',
        updatedAt: new Date('2026-04-20T09:01:00.000Z'),
      }),
      makeEntry({
        id: 'd1',
        type: 'decision',
        domain: 'architecture',
        tags: ['adr', 'pipeline'],
        confidence: 0.75,
        status: 'pending',
        updatedAt: new Date('2026-04-20T09:02:00.000Z'),
      }),
      makeEntry({
        id: 'e1',
        type: 'experience',
        domain: 'analytics',
        tags: ['metrics', 'weekly'],
        confidence: 0.55,
        status: 'deprecated',
        updatedAt: new Date('2026-04-20T09:03:00.000Z'),
      }),
    ]);

    const byType = await store.query({ type: 'fact' });
    expect(byType.total).toBe(1);
    expect(byType.items[0].id).toBe('f1');

    const byDomain = await store.query({ domain: 'analytics' });
    expect(byDomain.total).toBe(2);
    expect(byDomain.items.map((item) => item.id)).toEqual(['e1', 'f1']);

    const byTags = await store.query({ tags: ['metrics'] });
    expect(byTags.total).toBe(2);

    const byMultipleTags = await store.query({ tags: ['metrics', 'daily'] });
    expect(byMultipleTags.total).toBe(1);
    expect(byMultipleTags.items[0].id).toBe('f1');

    const byStatus = await store.query({ status: ['pending', 'deprecated'] });
    expect(byStatus.total).toBe(2);

    const byConfidence = await store.query({ confidence: { min: 0.7, max: 0.95 } });
    expect(byConfidence.total).toBe(2);
    expect(byConfidence.items.map((item) => item.id)).toEqual(['d1', 'f1']);

    const combined = await store.query({
      type: ['fact', 'experience'],
      domain: 'analytics',
      tags: ['metrics'],
      confidence: { min: 0.5, max: 0.93 },
      status: ['active', 'deprecated'],
    });
    expect(combined.total).toBe(2);
    expect(combined.items.map((item) => item.id)).toEqual(['e1', 'f1']);
  });

  it('supports batch operations and pagination', async () => {
    const saved = await store.saveMany([
      makeEntry({ id: 'b1', updatedAt: new Date('2026-04-20T09:01:00.000Z') }),
      makeEntry({ id: 'b2', updatedAt: new Date('2026-04-20T09:02:00.000Z') }),
      makeEntry({ id: 'b3', updatedAt: new Date('2026-04-20T09:03:00.000Z') }),
    ]);

    expect(saved).toHaveLength(3);

    const page = await store.query({}, { offset: 1, limit: 1 });
    expect(page.total).toBe(3);
    expect(page.offset).toBe(1);
    expect(page.limit).toBe(1);
    expect(page.hasMore).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe('b2');

    const deletedCount = await store.deleteMany(['b1', 'b3', 'missing']);
    expect(deletedCount).toBe(2);

    const remaining = await store.query();
    expect(remaining.total).toBe(1);
    expect(remaining.items[0].id).toBe('b2');
  });

  it('returns empty results for unmatched queries and isolates stored copies', async () => {
    const original = makeEntry({ id: 'immut', tags: ['one'] });
    const saved = await store.save(original);
    saved.tags.push('mutated');
    original.title = 'changed outside';

    const found = await store.get('immut');
    expect(found?.title).toBe('title-immut');
    expect(found?.tags).toEqual(['one']);

    const empty = await store.query({ domain: 'missing-domain' });
    expect(empty.total).toBe(0);
    expect(empty.items).toEqual([]);
    expect(empty.hasMore).toBe(false);
  });
});
