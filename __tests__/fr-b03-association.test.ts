import { beforeEach, describe, expect, it } from 'vitest';
import { AssociationStore } from '../src/association/index.js';
import { AssociationDiscovery } from '../src/association/association-discovery.js';
import { AssociationEnhancedRetrieval } from '../src/association/association-retrieval.js';
import type { Association, AssociationType } from '../src/association/index.js';
import type { KnowledgeEntry, KnowledgeSource } from '../src/types/index.js';
import type { KnowledgeRepository } from '../src/repository/index.js';
import type { SearchResult } from '../src/repository/storage-provider.js';

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'test://fr-b03',
  timestamp: new Date('2026-04-30T10:00:00.000Z'),
  agent: 'test',
};

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    type: 'fact',
    title: `title ${id}`,
    content: `content for ${id}`,
    summary: `summary of ${id}`,
    source: testSource,
    confidence: 0.85,
    status: 'active',
    tags: ['core'],
    domain: 'testing',
    createdAt: new Date('2026-04-30T10:00:00.000Z'),
    updatedAt: new Date('2026-04-30T10:00:00.000Z'),
    version: 1,
    ...overrides,
  };
}

function mockRepo(entries: KnowledgeEntry[]): KnowledgeRepository {
  const map = new Map(entries.map((e) => [e.id, e]));
  return {
    findAll: async () => [...entries],
    findById: async (id: string) => map.get(id) ?? null,
    save: async () => {},
    search: async () => [],
    updateStatus: async () => {},
    getVersionHistory: async () => [],
    findByType: async () => [],
    fullTextSearch: async () => [],
    delete: async () => {},
    count: async () => entries.length,
    close: async () => {},
  } as unknown as KnowledgeRepository;
}

describe('FR-B03: Knowledge Association', () => {
  describe('AC1: association types include supplements, supersedes, conflicts, depends_on', () => {
    let store: AssociationStore;

    beforeEach(() => {
      store = new AssociationStore();
    });

    it('supports all four required association types', () => {
      const types: AssociationType[] = ['supplements', 'supersedes', 'conflicts', 'depends_on'];
      for (const type of types) {
        const assoc: Association = {
          sourceId: 'a',
          targetId: `b-${type}`,
          type,
          strength: 0.7,
        };
        const saved = store.add(assoc);
        expect(saved.type).toBe(type);
      }
      const all = store.getBySource('a');
      expect(all).toHaveLength(4);
      expect(new Set(all.map((a) => a.type))).toEqual(new Set(types));
    });

    it('stores strength as a 0-1 value and rejects out-of-range', () => {
      store.add({ sourceId: 'a', targetId: 'b', type: 'supplements', strength: 0 });
      store.add({ sourceId: 'a', targetId: 'c', type: 'supplements', strength: 1 });
      expect(store.getBySource('a')).toHaveLength(2);
      expect(() =>
        store.add({ sourceId: 'a', targetId: 'd', type: 'supplements', strength: -0.1 })
      ).toThrow();
      expect(() =>
        store.add({ sourceId: 'a', targetId: 'e', type: 'supplements', strength: 1.5 })
      ).toThrow();
    });

    it('supports manual add and remove of associations', () => {
      store.add({ sourceId: 'x', targetId: 'y', type: 'conflicts', strength: 0.6 });
      expect(store.getBySource('x')).toHaveLength(1);
      expect(store.remove('x', 'y')).toBe(true);
      expect(store.getBySource('x')).toHaveLength(0);
    });

    it('supports metadata on associations', () => {
      store.add({
        sourceId: 'a',
        targetId: 'b',
        type: 'depends_on',
        strength: 0.8,
        metadata: { reason: 'API dependency' },
      });
      const fetched = store.getBySource('a')[0];
      expect(fetched.metadata).toEqual({ reason: 'API dependency' });
    });
  });

  describe('AC2: auto-detect potential associations on new entry', () => {
    it('detects supersedes when entry has explicit supersedes field', async () => {
      const old = makeEntry({ id: 'old-1', title: 'react hooks guide', domain: 'frontend' });
      const newer = makeEntry({
        id: 'new-1',
        title: 'react hooks guide v2',
        domain: 'frontend',
        supersedes: 'old-1',
      });
      const repo = mockRepo([old, newer]);
      const store = new AssociationStore();
      const discovery = new AssociationDiscovery(repo, store);

      const candidates = await discovery.discoverForEntry(newer);
      const sup = candidates.find((c) => c.type === 'supersedes');
      expect(sup).toBeDefined();
      expect(sup!.targetId).toBe('old-1');
      expect(sup!.strength).toBeGreaterThanOrEqual(0.9);
    });

    it('detects depends_on when content references another title', async () => {
      const base = makeEntry({
        id: 'base-1',
        title: 'authentication module',
        domain: 'backend',
        content: 'handles user login and token refresh',
      });
      const dependent = makeEntry({
        id: 'dep-1',
        title: 'user profile service',
        domain: 'backend',
        content: 'the user profile service relies on the authentication module for session validation',
      });
      const repo = mockRepo([base, dependent]);
      const store = new AssociationStore();
      const discovery = new AssociationDiscovery(repo, store);

      const candidates = await discovery.discoverForEntry(dependent);
      const dep = candidates.find((c) => c.type === 'depends_on');
      expect(dep).toBeDefined();
      expect(dep!.targetId).toBe('base-1');
    });

    it('detects supplements for same-source entries', async () => {
      const sharedSource: KnowledgeSource = {
        type: 'document',
        reference: 'doc://shared-doc',
        timestamp: new Date('2026-04-30T10:00:00.000Z'),
      };
      const a = makeEntry({ id: 'ss-1', source: sharedSource, domain: 'ops', content: 'deployment steps for staging' });
      const b = makeEntry({ id: 'ss-2', source: sharedSource, domain: 'ops', content: 'monitoring setup after deployment' });
      const repo = mockRepo([a, b]);
      const store = new AssociationStore();
      const discovery = new AssociationDiscovery(repo, store);

      const candidates = await discovery.discoverForEntry(b);
      const supp = candidates.find((c) => c.type === 'supplements');
      expect(supp).toBeDefined();
      expect(supp!.targetId).toBe('ss-1');
    });

    it('auto-commits discovered associations when autoCommit is true', async () => {
      const a = makeEntry({ id: 'ac-1', title: 'api gateway', domain: 'infra', content: 'routes traffic to services' });
      const b = makeEntry({
        id: 'ac-2',
        title: 'service mesh',
        domain: 'infra',
        content: 'the service mesh depends on the api gateway for ingress routing',
      });
      const repo = mockRepo([a, b]);
      const store = new AssociationStore();
      const discovery = new AssociationDiscovery(repo, store);

      await discovery.discoverForEntry(b, { autoCommit: true });
      const committed = store.getBySource('ac-2');
      expect(committed.length).toBeGreaterThan(0);
      expect(committed.every((a) => a.metadata?.autoDiscovered === true)).toBe(true);
    });

    it('respects similarityThreshold and maxCandidates', async () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry({
          id: `th-${i}`,
          title: `knowledge item ${i}`,
          domain: 'testing',
          tags: ['shared'],
          content: `shared content about knowledge item testing topic ${i}`,
          source: { ...testSource, reference: 'test://same-source' },
        })
      );
      const repo = mockRepo(entries);
      const store = new AssociationStore();
      const discovery = new AssociationDiscovery(repo, store);

      const all = await discovery.discoverForEntry(entries[0], { similarityThreshold: 0.1 });
      const limited = await discovery.discoverForEntry(entries[0], {
        similarityThreshold: 0.1,
        maxCandidates: 3,
      });
      expect(limited.length).toBeLessThanOrEqual(3);
      expect(limited.length).toBeLessThanOrEqual(all.length);
    });
  });
  describe('AC3: associations enhance retrieval completeness', () => {
    let store: AssociationStore;
    let entries: KnowledgeEntry[];
    let repo: KnowledgeRepository;

    beforeEach(() => {
      store = new AssociationStore();
      entries = [
        makeEntry({ id: 'r-1', title: 'react state management', domain: 'frontend' }),
        makeEntry({ id: 'r-2', title: 'redux toolkit setup', domain: 'frontend' }),
        makeEntry({ id: 'r-3', title: 'zustand alternative', domain: 'frontend' }),
        makeEntry({ id: 'r-4', title: 'unrelated backend topic', domain: 'backend' }),
      ];
      repo = mockRepo(entries);
      store.add({ sourceId: 'r-1', targetId: 'r-2', type: 'supplements', strength: 0.8 });
      store.add({ sourceId: 'r-1', targetId: 'r-3', type: 'supplements', strength: 0.6 });
      store.add({ sourceId: 'r-2', targetId: 'r-4', type: 'depends_on', strength: 0.3 });
    });

    it('enhances search results with associated entries', async () => {
      const retrieval = new AssociationEnhancedRetrieval(repo, store);
      const baseResults: SearchResult[] = [{ entry: entries[0], score: 0.9 }];

      const enhanced = await retrieval.enhance(baseResults);
      expect(enhanced).toHaveLength(1);
      expect(enhanced[0].associatedEntries.length).toBeGreaterThan(0);
      const associatedIds = enhanced[0].associatedEntries.map((a) => a.entry.id);
      expect(associatedIds).toContain('r-2');
      expect(associatedIds).toContain('r-3');
    });

    it('expandResults adds associated entries to result list with derived scores', async () => {
      const retrieval = new AssociationEnhancedRetrieval(repo, store);
      const baseResults: SearchResult[] = [{ entry: entries[0], score: 0.9 }];

      const expanded = await retrieval.expandResults(baseResults);
      expect(expanded.length).toBeGreaterThan(1);
      expect(expanded[0].entry.id).toBe('r-1');
      const ids = expanded.map((r) => r.entry.id);
      expect(ids).toContain('r-2');
      expect(ids).toContain('r-3');
      for (const r of expanded.slice(1)) {
        expect(r.score).toBeLessThan(0.9);
        expect(r.score).toBeGreaterThan(0);
      }
    });

    it('respects minAssociationStrength filter', async () => {
      const retrieval = new AssociationEnhancedRetrieval(repo, store);
      const baseResults: SearchResult[] = [{ entry: entries[0], score: 0.9 }];

      const enhanced = await retrieval.enhance(baseResults, { minAssociationStrength: 0.7 });
      const ids = enhanced[0].associatedEntries.map((a) => a.entry.id);
      expect(ids).toContain('r-2');
      expect(ids).not.toContain('r-3');
    });

    it('respects includeTypes filter', async () => {
      const retrieval = new AssociationEnhancedRetrieval(repo, store);
      const baseResults: SearchResult[] = [{ entry: entries[0], score: 0.9 }];

      const enhanced = await retrieval.enhance(baseResults, { includeTypes: ['supplements'] });
      for (const assoc of enhanced[0].associatedEntries) {
        expect(assoc.viaType).toBe('supplements');
      }
    });

    it('respects maxAssociatedPerResult limit', async () => {
      const retrieval = new AssociationEnhancedRetrieval(repo, store);
      const baseResults: SearchResult[] = [{ entry: entries[0], score: 0.9 }];

      const enhanced = await retrieval.enhance(baseResults, { maxAssociatedPerResult: 1 });
      expect(enhanced[0].associatedEntries).toHaveLength(1);
      expect(enhanced[0].associatedEntries[0].entry.id).toBe('r-2');
    });

    it('does not duplicate entries already in results', async () => {
      const retrieval = new AssociationEnhancedRetrieval(repo, store);
      const baseResults: SearchResult[] = [
        { entry: entries[0], score: 0.9 },
        { entry: entries[1], score: 0.7 },
      ];

      const enhanced = await retrieval.enhance(baseResults);
      const firstAssocIds = enhanced[0].associatedEntries.map((a) => a.entry.id);
      expect(firstAssocIds).not.toContain('r-2');
    });

    it('includes incoming associations', async () => {
      store.add({ sourceId: 'r-3', targetId: 'r-1', type: 'depends_on', strength: 0.75 });
      const retrieval = new AssociationEnhancedRetrieval(repo, store);
      const baseResults: SearchResult[] = [{ entry: entries[0], score: 0.9 }];

      const enhanced = await retrieval.enhance(baseResults);
      const directions = enhanced[0].associatedEntries.map((a) => ({
        id: a.entry.id,
        dir: a.direction,
      }));
      const incoming = directions.find((d) => d.id === 'r-3' && d.dir === 'incoming');
      expect(incoming).toBeDefined();
    });
  });

  describe('AC4: associations serve as edge data for knowledge graph', () => {
    it('associations are consumed by KnowledgeGraphBuilder as explicit edges', async () => {
      const { KnowledgeGraphBuilder } = await import('../src/association/knowledge-graph.js');
      const entries: KnowledgeEntry[] = [
        makeEntry({ id: 'g-1', title: 'node alpha', domain: 'graph' }),
        makeEntry({ id: 'g-2', title: 'node beta', domain: 'graph' }),
        makeEntry({ id: 'g-3', title: 'node gamma', domain: 'graph' }),
      ];
      const repo = mockRepo(entries);
      const associations: Association[] = [
        { sourceId: 'g-1', targetId: 'g-2', type: 'supplements', strength: 0.7 },
        { sourceId: 'g-2', targetId: 'g-3', type: 'depends_on', strength: 0.85 },
      ];

      const builder = new KnowledgeGraphBuilder(repo);
      const snapshot = await builder.build(associations);

      expect(snapshot.nodes).toHaveLength(3);
      const explicitEdges = snapshot.edges.filter((e) => e.signal === 'explicit');
      expect(explicitEdges).toHaveLength(2);
      expect(explicitEdges[0].type).toBe('supplements');
      expect(explicitEdges[1].type).toBe('depends_on');
    });

    it('graph edges preserve association type and strength', async () => {
      const { buildSnapshot } = await import('../src/association/knowledge-graph.js');
      const entries: KnowledgeEntry[] = [
        makeEntry({ id: 'e-1', title: 'entry one', domain: 'test' }),
        makeEntry({ id: 'e-2', title: 'entry two', domain: 'test' }),
      ];
      const associations: Association[] = [
        { sourceId: 'e-1', targetId: 'e-2', type: 'conflicts', strength: 0.65 },
      ];

      const snapshot = buildSnapshot(entries, associations, new Date());
      const edge = snapshot.edges.find((e) => e.signal === 'explicit');
      expect(edge).toBeDefined();
      expect(edge!.type).toBe('conflicts');
      expect(edge!.strength).toBeCloseTo(0.65);
      expect(edge!.sourceId).toBe('e-1');
      expect(edge!.targetId).toBe('e-2');
    });
  });
});

