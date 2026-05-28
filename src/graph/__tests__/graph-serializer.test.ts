import { describe, expect, it, beforeEach } from 'vitest';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { GraphInsightEngine } from '../graph-insight-engine.js';
import { GraphSerializer } from '../graph-serializer.js';
import type { KnowledgeEntry, KnowledgeSource } from '../../types/index.js';

const testSource = (ref: string): KnowledgeSource => ({
  type: 'document',
  reference: ref,
  timestamp: new Date('2026-04-20T09:00:00.000Z'),
});

let idCounter = 0;
function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `entry-${++idCounter}`;
  return {
    id, type: 'fact', title: `Entry ${id}`, content: 'c', summary: 's',
    source: testSource(`doc://${id}`), confidence: 0.9, status: 'active',
    tags: ['test'], domain: overrides.domain ?? 'default',
    createdAt: new Date('2026-04-10'), updatedAt: new Date('2026-04-10'), version: 1,
    ...overrides,
  };
}

describe('GraphSerializer', () => {
  let graph: KnowledgeGraph;
  let engine: GraphInsightEngine;
  let serializer: GraphSerializer;

  beforeEach(() => {
    idCounter = 0;
    graph = new KnowledgeGraph();
    engine = new GraphInsightEngine({
      idGenerator: (() => { let c = 0; return () => `ins-${++c}`; })(),
    });
    serializer = new GraphSerializer();
  });

  describe('FR-G03 AC1: serialized graph with nodes, edges, metadata', () => {
    it('serializes full graph with force-directed layout data', () => {
      graph.addEntry(makeEntry({ id: 'n1', type: 'fact', domain: 'alpha' }));
      graph.addEntry(makeEntry({ id: 'n2', type: 'methodology', domain: 'beta' }));
      graph.addExplicitEdge({ sourceId: 'n1', targetId: 'n2', type: 'supplements', strength: 0.8 });

      const insights = engine.analyze(graph);
      const result = serializer.serialize(graph, insights);

      expect(result.nodes).toHaveLength(2);
      expect(result.nodes[0].type).toBeDefined();
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].source).toBe('n1');
      expect(result.edges[0].target).toBe('n2');
      expect(result.edges[0].associationType).toBe('supplements');
      expect(result.edges[0].edgeSource).toBe('explicit');
    });
  });

  describe('FR-G03 AC3: filter by domain and type', () => {
    it('filters nodes by domain', () => {
      graph.addEntry(makeEntry({ id: 'a1', domain: 'alpha' }));
      graph.addEntry(makeEntry({ id: 'b1', domain: 'beta' }));
      graph.addExplicitEdge({ sourceId: 'a1', targetId: 'b1', type: 'supplements', strength: 0.8 });

      const insights = engine.analyze(graph);
      const result = serializer.serialize(graph, insights, { domains: ['alpha'] });

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].id).toBe('a1');
      expect(result.edges).toHaveLength(0);
    });

    it('filters nodes by knowledge type', () => {
      graph.addEntry(makeEntry({ id: 'f1', type: 'fact' }));
      graph.addEntry(makeEntry({ id: 'm1', type: 'methodology' }));

      const insights = engine.analyze(graph);
      const result = serializer.serialize(graph, insights, { types: ['methodology'] });

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].id).toBe('m1');
    });
  });

  describe('FR-G03 AC4: node summary card data', () => {
    it('includes title, type, domain, tags per node', () => {
      graph.addEntry(makeEntry({ id: 'n1', type: 'decision', domain: 'arch', tags: ['adr'] }));
      const insights = engine.analyze(graph);
      const result = serializer.serialize(graph, insights);

      const node = result.nodes[0];
      expect(node.title).toBe('Entry n1');
      expect(node.type).toBe('decision');
      expect(node.domain).toBe('arch');
      expect(node.tags).toEqual(['adr']);
    });
  });

  describe('FR-G03 AC5: insight markers on nodes', () => {
    it('marks isolated nodes in serialized output', () => {
      graph.addEntry(makeEntry({ id: 'lonely' }));
      graph.addEntry(makeEntry({ id: 'a' }));
      graph.addEntry(makeEntry({ id: 'b' }));
      graph.addExplicitEdge({ sourceId: 'a', targetId: 'b', type: 'supplements', strength: 0.9 });

      const insights = engine.analyze(graph);
      const result = serializer.serialize(graph, insights);

      const lonelyNode = result.nodes.find((n) => n.id === 'lonely');
      expect(lonelyNode).toBeDefined();
      expect(lonelyNode!.insightMarkers).toContain('isolated_node');
    });

    it('includes insight details in serialized insights array', () => {
      graph.addEntry(makeEntry({ id: 'x1', domain: 'physics' }));
      graph.addEntry(makeEntry({ id: 'x2', domain: 'cooking' }));
      graph.addExplicitEdge({ sourceId: 'x1', targetId: 'x2', type: 'supplements', strength: 0.6 });

      const insights = engine.analyze(graph);
      const result = serializer.serialize(graph, insights);

      expect(result.insights.length).toBeGreaterThan(0);
      for (const ins of result.insights) {
        expect(ins.id).toBeDefined();
        expect(ins.type).toBeDefined();
        expect(ins.description).toBeDefined();
        expect(ins.affectedNodeIds.length).toBeGreaterThan(0);
      }
    });
  });

  describe('metadata', () => {
    it('includes counts, domains, and builtAt', () => {
      graph.addEntry(makeEntry({ id: 'n1', domain: 'a' }));
      graph.addEntry(makeEntry({ id: 'n2', domain: 'b' }));
      graph.addExplicitEdge({ sourceId: 'n1', targetId: 'n2', type: 'supplements', strength: 0.8 });

      const insights = engine.analyze(graph);
      const result = serializer.serialize(graph, insights);

      expect(result.metadata.nodeCount).toBe(2);
      expect(result.metadata.edgeCount).toBe(1);
      expect(result.metadata.domains).toEqual(['a', 'b']);
      expect(typeof result.metadata.builtAt).toBe('string');
    });
  });
});
