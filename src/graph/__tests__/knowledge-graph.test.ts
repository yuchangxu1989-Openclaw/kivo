import { describe, expect, it, beforeEach } from 'vitest';
import { KnowledgeGraph } from '../knowledge-graph.js';
import type { KnowledgeEntry, KnowledgeSource } from '../../types/index.js';
import type { Association } from '../../association/association-types.js';

const testSource = (ref: string): KnowledgeSource => ({
  type: 'document',
  reference: ref,
  timestamp: new Date('2026-04-20T09:00:00.000Z'),
});

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    type: 'fact',
    title: `Entry ${id}`,
    content: 'content',
    summary: 'summary',
    source: testSource(`doc://${id}`),
    confidence: 0.9,
    status: 'active',
    tags: ['test'],
    domain: 'testing',
    createdAt: new Date('2026-04-10T09:00:00.000Z'),
    updatedAt: new Date('2026-04-10T09:00:00.000Z'),
    version: 1,
    ...overrides,
  };
}

describe('KnowledgeGraph', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph();
  });

  describe('FR-G01 AC1: nodes correspond to entries, edges to associations', () => {
    it('adds entries as nodes', () => {
      const entry = makeEntry({ id: 'e1' });
      const node = graph.addEntry(entry);
      expect(node.entryId).toBe('e1');
      expect(node.type).toBe('fact');
      expect(node.title).toBe('Entry e1');
      expect(graph.nodeCount).toBe(1);
    });

    it('adds explicit associations as edges', () => {
      graph.addEntry(makeEntry({ id: 'e1' }));
      graph.addEntry(makeEntry({ id: 'e2' }));
      const assoc: Association = {
        sourceId: 'e1',
        targetId: 'e2',
        type: 'supplements',
        strength: 0.8,
      };
      const edge = graph.addExplicitEdge(assoc);
      expect(edge.sourceId).toBe('e1');
      expect(edge.targetId).toBe('e2');
      expect(edge.associationType).toBe('supplements');
      expect(edge.edgeSource).toBe('explicit');
      expect(graph.edgeCount).toBe(1);
    });

    it('supports all association types as edges', () => {
      graph.addEntry(makeEntry({ id: 'a' }));
      graph.addEntry(makeEntry({ id: 'b' }));
      graph.addEntry(makeEntry({ id: 'c' }));
      graph.addEntry(makeEntry({ id: 'd' }));
      graph.addEntry(makeEntry({ id: 'e' }));

      graph.addExplicitEdge({ sourceId: 'a', targetId: 'b', type: 'supplements', strength: 0.7 });
      graph.addExplicitEdge({ sourceId: 'a', targetId: 'c', type: 'supersedes', strength: 0.9 });
      graph.addExplicitEdge({ sourceId: 'a', targetId: 'd', type: 'conflicts', strength: 0.6 });
      graph.addExplicitEdge({ sourceId: 'a', targetId: 'e', type: 'depends_on', strength: 0.8 });

      const edges = graph.getEdges('a');
      const types = edges.map((e) => e.associationType).sort();
      expect(types).toEqual(['conflicts', 'depends_on', 'supersedes', 'supplements']);
    });
  });

  describe('FR-G01 AC2: multiple edge signal sources', () => {
    it('adds co-occurrence edges', () => {
      graph.addEntry(makeEntry({ id: 'e1' }));
      graph.addEntry(makeEntry({ id: 'e2' }));
      const edge = graph.addCoOccurrenceEdge('e1', 'e2', 0.7);
      expect(edge.edgeSource).toBe('co_occurrence');
      expect(edge.weight).toBe(0.7);
    });

    it('adds semantic edges above threshold', () => {
      graph = new KnowledgeGraph({ semanticThreshold: 0.8 });
      graph.addEntry(makeEntry({ id: 'e1' }));
      graph.addEntry(makeEntry({ id: 'e2' }));
      const edge = graph.addSemanticEdge('e1', 'e2', 0.85);
      expect(edge).not.toBeNull();
      expect(edge!.edgeSource).toBe('semantic');
    });

    it('rejects semantic edges below threshold', () => {
      graph = new KnowledgeGraph({ semanticThreshold: 0.8 });
      graph.addEntry(makeEntry({ id: 'e1' }));
      graph.addEntry(makeEntry({ id: 'e2' }));
      const edge = graph.addSemanticEdge('e1', 'e2', 0.5);
      expect(edge).toBeNull();
      expect(graph.edgeCount).toBe(0);
    });
  });

  describe('FR-G01 AC3: incremental update', () => {
    it('adds new node without rebuilding existing edges', () => {
      graph.addEntry(makeEntry({ id: 'e1' }));
      graph.addEntry(makeEntry({ id: 'e2' }));
      graph.addExplicitEdge({ sourceId: 'e1', targetId: 'e2', type: 'supplements', strength: 0.8 });

      graph.addEntry(makeEntry({ id: 'e3' }));
      graph.addExplicitEdge({ sourceId: 'e1', targetId: 'e3', type: 'depends_on', strength: 0.7 });

      expect(graph.nodeCount).toBe(3);
      expect(graph.edgeCount).toBe(2);
      expect(graph.getNeighbors('e1')).toHaveLength(2);
    });

    it('removes node and cleans up edges', () => {
      graph.addEntry(makeEntry({ id: 'e1' }));
      graph.addEntry(makeEntry({ id: 'e2' }));
      graph.addEntry(makeEntry({ id: 'e3' }));
      graph.addExplicitEdge({ sourceId: 'e1', targetId: 'e2', type: 'supplements', strength: 0.8 });
      graph.addExplicitEdge({ sourceId: 'e1', targetId: 'e3', type: 'supplements', strength: 0.7 });

      graph.removeEntry('e1');
      expect(graph.nodeCount).toBe(2);
      expect(graph.edgeCount).toBe(0);
    });

    it('removes individual edges', () => {
      graph.addEntry(makeEntry({ id: 'e1' }));
      graph.addEntry(makeEntry({ id: 'e2' }));
      graph.addExplicitEdge({ sourceId: 'e1', targetId: 'e2', type: 'supplements', strength: 0.8 });

      expect(graph.removeEdge('e1', 'e2')).toBe(true);
      expect(graph.edgeCount).toBe(0);
      expect(graph.nodeCount).toBe(2);
    });
  });

  describe('FR-G01 AC4: snapshot API', () => {
    it('returns complete graph snapshot', () => {
      graph.addEntry(makeEntry({ id: 'e1', domain: 'alpha' }));
      graph.addEntry(makeEntry({ id: 'e2', domain: 'beta' }));
      graph.addExplicitEdge({ sourceId: 'e1', targetId: 'e2', type: 'supplements', strength: 0.8 });

      const snap = graph.snapshot();
      expect(snap.nodes).toHaveLength(2);
      expect(snap.edges).toHaveLength(1);
      expect(snap.metadata.nodeCount).toBe(2);
      expect(snap.metadata.edgeCount).toBe(1);
      expect(snap.metadata.domains).toEqual(['alpha', 'beta']);
      expect(snap.metadata.builtAt).toBeInstanceOf(Date);
    });
  });

  describe('graph queries', () => {
    it('getNeighbors returns direct neighbors', () => {
      graph.addEntry(makeEntry({ id: 'e1' }));
      graph.addEntry(makeEntry({ id: 'e2' }));
      graph.addEntry(makeEntry({ id: 'e3' }));
      graph.addExplicitEdge({ sourceId: 'e1', targetId: 'e2', type: 'supplements', strength: 0.8 });

      const neighbors = graph.getNeighbors('e1');
      expect(neighbors).toHaveLength(1);
      expect(neighbors[0].entryId).toBe('e2');
    });

    it('getDegree returns edge count for node', () => {
      graph.addEntry(makeEntry({ id: 'e1' }));
      graph.addEntry(makeEntry({ id: 'e2' }));
      graph.addEntry(makeEntry({ id: 'e3' }));
      graph.addExplicitEdge({ sourceId: 'e1', targetId: 'e2', type: 'supplements', strength: 0.8 });
      graph.addExplicitEdge({ sourceId: 'e1', targetId: 'e3', type: 'depends_on', strength: 0.7 });

      expect(graph.getDegree('e1')).toBe(2);
      expect(graph.getDegree('e2')).toBe(1);
    });
  });
});
