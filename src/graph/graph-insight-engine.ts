import { randomUUID } from 'node:crypto';
import type { KnowledgeGraph } from './knowledge-graph.js';
import type { Insight, InsightResult, ImportanceLevel } from './graph-types.js';
import type { ResearchTask } from '../research/research-task-types.js';
import type { KnowledgeGap } from '../research/gap-detection-types.js';
import { ResearchTaskGenerator } from '../research/research-task-generator.js';

export interface GraphInsightEngineOptions {
  isolatedThreshold?: number;
  sparseEdgeRatio?: number;
  minCommunitySize?: number;
  maxBridgeDetectionNodes?: number;
  idGenerator?: () => string;
}

export class GraphInsightEngine {
  private readonly isolatedThreshold: number;
  private readonly sparseEdgeRatio: number;
  private readonly minCommunitySize: number;
  private readonly maxBridgeDetectionNodes: number;
  private readonly idGenerator: () => string;

  constructor(options: GraphInsightEngineOptions = {}) {
    this.isolatedThreshold = options.isolatedThreshold ?? 1;
    this.sparseEdgeRatio = options.sparseEdgeRatio ?? 0.3;
    this.minCommunitySize = options.minCommunitySize ?? 3;
    this.maxBridgeDetectionNodes = options.maxBridgeDetectionNodes ?? 500;
    this.idGenerator = options.idGenerator ?? randomUUID;
  }

  analyze(graph: KnowledgeGraph): InsightResult {
    const insights: Insight[] = [
      ...this.findIsolatedNodes(graph),
      ...this.findBridgeNodes(graph),
      ...this.findSparseCommunities(graph),
      ...this.findUnexpectedLinks(graph),
    ];
    return { insights, analyzedAt: new Date() };
  }

  findIsolatedNodes(graph: KnowledgeGraph): Insight[] {
    const snap = graph.snapshot();
    return snap.nodes
      .filter((node) => graph.getDegree(node.entryId) <= this.isolatedThreshold)
      .map((node) => ({
        id: this.idGenerator(),
        type: 'isolated_node' as const,
        description: `"${node.title}" 几乎不参与任何关联（度=${graph.getDegree(node.entryId)}）`,
        importance: 'low' as ImportanceLevel,
        affectedNodeIds: [node.entryId],
      }));
  }

  findBridgeNodes(graph: KnowledgeGraph): Insight[] {
    const snap = graph.snapshot();
    if (snap.nodes.length > this.maxBridgeDetectionNodes) {
      return [];
    }
    const baseCount = this.detectCommunities(graph).length;
    const bridges: Insight[] = [];

    for (const node of snap.nodes) {
      const neighbors = graph.getNeighbors(node.entryId);
      if (neighbors.length < 2) {
        continue;
      }

      const excluded = new Set([node.entryId]);
      const visited = new Set<string>();
      let componentCount = 0;

      for (const n of snap.nodes) {
        if (excluded.has(n.entryId) || visited.has(n.entryId)) {
          continue;
        }
        componentCount++;
        const queue = [n.entryId];
        visited.add(n.entryId);
        while (queue.length > 0) {
          const current = queue.shift()!;
          for (const nb of graph.getNeighbors(current)) {
            if (!excluded.has(nb.entryId) && !visited.has(nb.entryId)) {
              visited.add(nb.entryId);
              queue.push(nb.entryId);
            }
          }
        }
      }

      if (componentCount > baseCount) {
        const splitCount = componentCount - baseCount + 1;
        const importance: ImportanceLevel = splitCount >= 3 ? 'high' : 'medium';
        bridges.push({
          id: this.idGenerator(),
          type: 'bridge_node',
          description: `"${node.title}" 连接 ${splitCount} 个主题群`,
          importance,
          affectedNodeIds: [node.entryId],
          metadata: { communityCount: splitCount },
        });
      }
    }
    return bridges;
  }

  findSparseCommunities(graph: KnowledgeGraph): Insight[] {
    const communities = this.detectCommunities(graph);
    const results: Insight[] = [];

    for (const members of communities) {
      if (members.length < this.minCommunitySize) {
        continue;
      }
      let internalEdges = 0;
      const memberSet = new Set(members);
      for (const id of members) {
        const edges = graph.getEdges(id);
        for (const edge of edges) {
          const otherId = edge.sourceId === id ? edge.targetId : edge.sourceId;
          if (memberSet.has(otherId)) {
            internalEdges++;
          }
        }
      }
      internalEdges = Math.floor(internalEdges / 2);
      const maxEdges = (members.length * (members.length - 1)) / 2;
      const ratio = maxEdges > 0 ? internalEdges / maxEdges : 0;

      if (ratio < this.sparseEdgeRatio) {
        results.push({
          id: this.idGenerator(),
          type: 'sparse_community',
          description: `${members.length} 个条目的主题群内部关联密度仅 ${(ratio * 100).toFixed(0)}%`,
          importance: ratio < 0.1 ? 'high' : 'medium',
          affectedNodeIds: [...members],
          metadata: { density: ratio, memberCount: members.length },
        });
      }
    }
    return results;
  }

  findUnexpectedLinks(graph: KnowledgeGraph): Insight[] {
    const snap = graph.snapshot();
    const results: Insight[] = [];

    for (const edge of snap.edges) {
      const sourceNode = graph.getNode(edge.sourceId);
      const targetNode = graph.getNode(edge.targetId);
      if (!sourceNode || !targetNode) {
        continue;
      }

      const sourceNeighbors = new Set(graph.getNeighbors(edge.sourceId).map((n) => n.entryId));
      const targetNeighbors = new Set(graph.getNeighbors(edge.targetId).map((n) => n.entryId));

      let commonNeighbors = 0;
      for (const id of sourceNeighbors) {
        if (targetNeighbors.has(id)) {
          commonNeighbors++;
        }
      }

      const denominator = Math.log(sourceNeighbors.size + 1) + Math.log(targetNeighbors.size + 1);
      const adamicAdar = denominator > 0 ? commonNeighbors / denominator : 0;

      const crossDomain = sourceNode.domain !== undefined
        && targetNode.domain !== undefined
        && sourceNode.domain !== targetNode.domain;

      if (crossDomain && adamicAdar < 0.5) {
        results.push({
          id: this.idGenerator(),
          type: 'unexpected_link',
          description: `跨域关联：「${sourceNode.title}」(${sourceNode.domain}) ↔ 「${targetNode.title}」(${targetNode.domain})`,
          importance: 'medium',
          affectedNodeIds: [edge.sourceId, edge.targetId],
          metadata: { adamicAdar, sourceDomain: sourceNode.domain, targetDomain: targetNode.domain },
        });
      }
    }
    return results;
  }

  triggerResearchFromInsights(insights: Insight[]): ResearchTask[] {
    const actionable = insights.filter(
      (i) => i.type === 'isolated_node' || i.type === 'sparse_community'
    );
    if (actionable.length === 0) return [];

    const generator = new ResearchTaskGenerator({ idGenerator: this.idGenerator });
    const gaps: KnowledgeGap[] = actionable.map((insight) => ({
      id: insight.id,
      type: 'graph_gap' as const,
      description: insight.description,
      priority: insight.importance === 'high' ? 'high' as const
        : insight.importance === 'medium' ? 'medium' as const
        : 'low' as const,
      evidence: {
        signal: insight.type === 'isolated_node' ? 'isolated_node' as const : 'sparse_community' as const,
        affectedIds: insight.affectedNodeIds,
        description: insight.description,
      },
    }));

    return generator.generate({ gaps, suggestions: [], detectedAt: new Date() });
  }

  private detectCommunities(graph: KnowledgeGraph): string[][] {
    const snap = graph.snapshot();
    const visited = new Set<string>();
    const communities: string[][] = [];

    for (const node of snap.nodes) {
      if (visited.has(node.entryId)) {
        continue;
      }
      const community: string[] = [];
      const queue = [node.entryId];
      visited.add(node.entryId);

      while (queue.length > 0) {
        const current = queue.shift()!;
        community.push(current);
        for (const neighbor of graph.getNeighbors(current)) {
          if (!visited.has(neighbor.entryId)) {
            visited.add(neighbor.entryId);
            queue.push(neighbor.entryId);
          }
        }
      }
      communities.push(community);
    }
    return communities;
  }
}
