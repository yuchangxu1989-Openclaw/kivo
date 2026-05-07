import { describe, expect, it, beforeEach } from 'vitest';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { GraphInsightEngine } from '../graph-insight-engine.js';
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

describe('GraphInsightEngine', () => {
  let graph: KnowledgeGraph;
  let engine: GraphInsightEngine;

  beforeEach(() => {
    idCounter = 0;
    graph = new KnowledgeGraph();
    engine = new GraphInsightEngine({
      isolatedThreshold: 1,
      sparseEdgeRatio: 0.3,
      minCommunitySize: 3,
      idGenerator: (() => { let c = 0; return () => `insight-${++c}`; })(),
    });
  });

  describe('FR-G02 AC1: isolated nodes', () => {
    it('detects nodes with no edges', () => {
      graph.addEntry(makeEntry({ id: 'lonely' }));
      graph.addEntry(makeEntry({ id: 'a' }));
      graph.addEntry(makeEntry({ id: 'b' }));
      graph.addExplicitEdge({ sourceId: 'a', targetId: 'b', type: 'supplements', strength: 0.8 });

      const result = engine.analyze(graph);
      const isolated = result.insights.filter((i) => i.type === 'isolated_node');
      expect(isolated.length).toBeGreaterThanOrEqual(1);
      const lonelyInsight = isolated.find((i) => i.affectedNodeIds.includes('lonely'));
      expect(lonelyInsight).toBeDefined();
    });

    it('nodes with degree <= threshold are isolated', () => {
      graph.addEntry(makeEntry({ id: 'a' }));
      graph.addEntry(makeEntry({ id: 'b' }));
      graph.addExplicitEdge({ sourceId: 'a', targetId: 'b', type: 'supplements', strength: 0.8 });

      const result = engine.findIsolatedNodes(graph);
      const ids = result.flatMap((i) => i.affectedNodeIds);
      expect(ids).toContain('a');
      expect(ids).toContain('b');
    });
  });

  describe('FR-G02 AC2: bridge nodes', () => {
    it('detects nodes connecting multiple communities', () => {
      graph.addEntry(makeEntry({ id: 'c1a' }));
      graph.addEntry(makeEntry({ id: 'c1b' }));
      graph.addEntry(makeEntry({ id: 'bridge' }));
      graph.addEntry(makeEntry({ id: 'c2a' }));
      graph.addEntry(makeEntry({ id: 'c2b' }));

      graph.addExplicitEdge({ sourceId: 'c1a', targetId: 'c1b', type: 'supplements', strength: 0.9 });
      graph.addExplicitEdge({ sourceId: 'c1a', targetId: 'bridge', type: 'supplements', strength: 0.7 });
      graph.addExplicitEdge({ sourceId: 'bridge', targetId: 'c2a', type: 'supplements', strength: 0.7 });
      graph.addExplicitEdge({ sourceId: 'c2a', targetId: 'c2b', type: 'supplements', strength: 0.9 });

      const bridges = engine.findBridgeNodes(graph);
      const bridgeIds = bridges.flatMap((i) => i.affectedNodeIds);
      expect(bridgeIds).toContain('bridge');
    });

    it('detects bridge connecting two clusters', () => {
      graph.addEntry(makeEntry({ id: 'left1' }));
      graph.addEntry(makeEntry({ id: 'left2' }));
      graph.addEntry(makeEntry({ id: 'left3' }));
      graph.addExplicitEdge({ sourceId: 'left1', targetId: 'left2', type: 'supplements', strength: 0.9 });
      graph.addExplicitEdge({ sourceId: 'left2', targetId: 'left3', type: 'supplements', strength: 0.9 });
      graph.addExplicitEdge({ sourceId: 'left1', targetId: 'left3', type: 'supplements', strength: 0.9 });

      graph.addEntry(makeEntry({ id: 'right1' }));
      graph.addEntry(makeEntry({ id: 'right2' }));
      graph.addEntry(makeEntry({ id: 'right3' }));
      graph.addExplicitEdge({ sourceId: 'right1', targetId: 'right2', type: 'supplements', strength: 0.9 });
      graph.addExplicitEdge({ sourceId: 'right2', targetId: 'right3', type: 'supplements', strength: 0.9 });
      graph.addExplicitEdge({ sourceId: 'right1', targetId: 'right3', type: 'supplements', strength: 0.9 });

      graph.addEntry(makeEntry({ id: 'bridge' }));
      graph.addExplicitEdge({ sourceId: 'bridge', targetId: 'left1', type: 'supplements', strength: 0.7 });
      graph.addExplicitEdge({ sourceId: 'bridge', targetId: 'right1', type: 'supplements', strength: 0.7 });

      const result = engine.analyze(graph);
      const bridges = result.insights.filter((i) => i.type === 'bridge_node');
      const bridgeInsight = bridges.find((i) => i.affectedNodeIds.includes('bridge'));
      expect(bridgeInsight).toBeDefined();
      expect(bridgeInsight!.importance).toBe('medium');
    });
  });

  describe('FR-G02 AC3: sparse communities', () => {
    it('detects communities with low internal density', () => {
      // 4 nodes connected in a line: 3 edges, max possible = 6, density = 0.5
      // Use sparseEdgeRatio=0.6 so this counts as sparse
      const sparseEngine = new GraphInsightEngine({
        sparseEdgeRatio: 0.6,
        minCommunitySize: 3,
        idGenerator: (() => { let c = 0; return () => `sp-${++c}`; })(),
      });

      graph.addEntry(makeEntry({ id: 's1' }));
      graph.addEntry(makeEntry({ id: 's2' }));
      graph.addEntry(makeEntry({ id: 's3' }));
      graph.addEntry(makeEntry({ id: 's4' }));
      graph.addExplicitEdge({ sourceId: 's1', targetId: 's2', type: 'supplements', strength: 0.5 });
      graph.addExplicitEdge({ sourceId: 's2', targetId: 's3', type: 'supplements', strength: 0.5 });
      graph.addExplicitEdge({ sourceId: 's3', targetId: 's4', type: 'supplements', strength: 0.5 });

      const sparse = sparseEngine.findSparseCommunities(graph);
      expect(sparse.length).toBeGreaterThanOrEqual(1);
      expect(sparse[0].type).toBe('sparse_community');
    });
  });

  describe('FR-G02 AC4: unexpected cross-domain links', () => {
    it('detects cross-domain edges with low common neighbors', () => {
      graph.addEntry(makeEntry({ id: 'x1', domain: 'physics' }));
      graph.addEntry(makeEntry({ id: 'x2', domain: 'cooking' }));
      graph.addExplicitEdge({ sourceId: 'x1', targetId: 'x2', type: 'supplements', strength: 0.6 });

      const unexpected = engine.findUnexpectedLinks(graph);
      expect(unexpected.length).toBeGreaterThanOrEqual(1);
      expect(unexpected[0].type).toBe('unexpected_link');
      expect(unexpected[0].affectedNodeIds).toContain('x1');
      expect(unexpected[0].affectedNodeIds).toContain('x2');
    });
  });

  describe('FR-G02 AC5: insights trigger research tasks', () => {
    it('insight result contains analyzedAt and structured insights', () => {
      graph.addEntry(makeEntry({ id: 'lone' }));
      const result = engine.analyze(graph);
      expect(result.analyzedAt).toBeInstanceOf(Date);
      expect(Array.isArray(result.insights)).toBe(true);
      for (const insight of result.insights) {
        expect(insight.id).toBeDefined();
        expect(insight.type).toBeDefined();
        expect(insight.affectedNodeIds.length).toBeGreaterThan(0);
      }
    });

    it('triggerResearchFromInsights converts isolated_node insights to research tasks', () => {
      graph.addEntry(makeEntry({ id: 'lone' }));
      const result = engine.analyze(graph);
      const isolated = result.insights.filter((i) => i.type === 'isolated_node');
      expect(isolated.length).toBeGreaterThan(0);

      const tasks = engine.triggerResearchFromInsights(isolated);
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks[0].gapType).toBe('graph_gap');
      expect(tasks[0].title).toContain('调研');
    });

    it('triggerResearchFromInsights returns empty for non-actionable insights', () => {
      graph.addEntry(makeEntry({ id: 'x1', domain: 'physics' }));
      graph.addEntry(makeEntry({ id: 'x2', domain: 'cooking' }));
      graph.addExplicitEdge({ sourceId: 'x1', targetId: 'x2', type: 'supplements', strength: 0.6 });
      const unexpected = engine.findUnexpectedLinks(graph);
      const tasks = engine.triggerResearchFromInsights(unexpected);
      expect(tasks).toEqual([]);
    });
  });

  describe('P1-1: maxBridgeDetectionNodes threshold', () => {
    it('skips bridge detection when node count exceeds threshold', () => {
      const smallEngine = new GraphInsightEngine({
        maxBridgeDetectionNodes: 3,
        idGenerator: (() => { let c = 0; return () => `b-${++c}`; })(),
      });
      for (let i = 0; i < 5; i++) {
        graph.addEntry(makeEntry({ id: `n${i}` }));
      }
      graph.addExplicitEdge({ sourceId: 'n0', targetId: 'n1', type: 'supplements', strength: 0.9 });
      graph.addExplicitEdge({ sourceId: 'n1', targetId: 'n2', type: 'supplements', strength: 0.9 });
      graph.addExplicitEdge({ sourceId: 'n2', targetId: 'n3', type: 'supplements', strength: 0.9 });
      graph.addExplicitEdge({ sourceId: 'n3', targetId: 'n4', type: 'supplements', strength: 0.9 });

      const bridges = smallEngine.findBridgeNodes(graph);
      expect(bridges).toEqual([]);
    });

    it('runs bridge detection when node count is within threshold', () => {
      const okEngine = new GraphInsightEngine({
        maxBridgeDetectionNodes: 100,
        idGenerator: (() => { let c = 0; return () => `b-${++c}`; })(),
      });
      graph.addEntry(makeEntry({ id: 'c1a' }));
      graph.addEntry(makeEntry({ id: 'c1b' }));
      graph.addEntry(makeEntry({ id: 'bridge' }));
      graph.addEntry(makeEntry({ id: 'c2a' }));
      graph.addEntry(makeEntry({ id: 'c2b' }));
      graph.addExplicitEdge({ sourceId: 'c1a', targetId: 'c1b', type: 'supplements', strength: 0.9 });
      graph.addExplicitEdge({ sourceId: 'c1a', targetId: 'bridge', type: 'supplements', strength: 0.7 });
      graph.addExplicitEdge({ sourceId: 'bridge', targetId: 'c2a', type: 'supplements', strength: 0.7 });
      graph.addExplicitEdge({ sourceId: 'c2a', targetId: 'c2b', type: 'supplements', strength: 0.9 });

      const bridges = okEngine.findBridgeNodes(graph);
      expect(bridges.length).toBeGreaterThan(0);
    });
  });
});
