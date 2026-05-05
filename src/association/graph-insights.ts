import type { KnowledgeGraphEdge, KnowledgeGraphNode, KnowledgeGraphSnapshot } from '../association/knowledge-graph.js';

export interface GraphInsight {
  type: 'isolated_node' | 'bridge_node' | 'sparse_community' | 'unexpected_association';
  nodeIds: string[];
  score: number;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface GraphVisualizationNode {
  id: string;
  label: string;
  color: string;
  size: number;
  type: KnowledgeGraphNode['type'];
  domain?: string;
  x?: number;
  y?: number;
  markers: GraphInsight['type'][];
}

export interface GraphVisualizationEdge {
  id: string;
  source: string;
  target: string;
  style: 'solid' | 'dashed' | 'dotted';
  color: string;
  width: number;
  type: KnowledgeGraphEdge['type'];
}

/**
 * FR-G03-AC4: Summary card data shown on node click.
 */
export interface NodeSummaryCard {
  entryId: string;
  title: string;
  type: KnowledgeGraphNode['type'];
  domain?: string;
  summary: string;
  confidence?: number;
  sourceRef: string;
  createdAt: Date;
  updatedAt: Date;
  neighborCount: number;
  insightMarkers: GraphInsight['type'][];
}

/**
 * FR-G03-AC2: Interaction capabilities descriptor.
 * Declares which interactions the visualization data supports.
 */
export interface GraphInteractionCapabilities {
  zoom: boolean;
  pan: boolean;
  nodeDrag: boolean;
  focusOnClick: boolean;
  summaryCardOnClick: boolean;
}

/**
 * FR-G02-AC5: Research task suggestion generated from an insight.
 */
export interface InsightResearchTask {
  insightType: GraphInsight['type'];
  title: string;
  description: string;
  targetNodeIds: string[];
  priority: 'low' | 'medium' | 'high';
}

export interface GraphVisualizationData {
  layout: 'force-directed';
  nodes: GraphVisualizationNode[];
  edges: GraphVisualizationEdge[];
  filters: {
    domains: string[];
    types: string[];
    timeRange?: { from?: Date; to?: Date };
  };
  /** FR-G03-AC2: Interaction capabilities */
  interactions: GraphInteractionCapabilities;
  /** FR-G03-AC4: Pre-built summary cards keyed by node id */
  summaryCards: Map<string, NodeSummaryCard>;
}

export interface InsightOptions {
  sparseCommunityThreshold?: number;
  bridgeCentralityThreshold?: number;
  unexpectedAssociationThreshold?: number;
}

export class GraphInsightAnalyzer {
  /**
   * FR-G02-AC5: Generate research task suggestions from insights.
   */
  toResearchTasks(insights: GraphInsight[]): InsightResearchTask[] {
    return insights.map((insight) => insightToResearchTask(insight)).filter((t): t is InsightResearchTask => t !== null);
  }

  /**
   * FR-G03-AC4: Build a summary card for a specific node.
   */
  buildSummaryCard(
    node: KnowledgeGraphNode,
    snapshot: KnowledgeGraphSnapshot,
    insights: GraphInsight[]
  ): NodeSummaryCard {
    const neighborCount = snapshot.edges.filter(
      (e) => e.sourceId === node.id || e.targetId === node.id
    ).length;
    const markers: GraphInsight['type'][] = [];
    for (const insight of insights) {
      if (insight.nodeIds.includes(node.id) && !markers.includes(insight.type)) {
        markers.push(insight.type);
      }
    }
    return {
      entryId: node.id,
      title: node.title,
      type: node.type,
      domain: node.domain,
      summary: node.summary,
      sourceRef: node.sourceRef,
      createdAt: new Date(node.createdAt),
      updatedAt: new Date(node.updatedAt),
      neighborCount,
      insightMarkers: markers,
    };
  }

  analyze(snapshot: KnowledgeGraphSnapshot, options: InsightOptions = {}): GraphInsight[] {
    const adjacency = buildAdjacency(snapshot);
    const insights: GraphInsight[] = [];

    insights.push(...findIsolatedNodes(snapshot, adjacency));
    insights.push(...findBridgeNodes(snapshot, adjacency, options));
    insights.push(...findSparseCommunities(snapshot, adjacency, options));
    insights.push(...findUnexpectedAssociations(snapshot, adjacency, options));

    return insights.sort((a, b) => b.score - a.score);
  }

  toVisualizationData(
    snapshot: KnowledgeGraphSnapshot,
    insights: GraphInsight[],
    filters: GraphVisualizationData['filters']
  ): GraphVisualizationData {
    const markerMap = new Map<string, GraphInsight['type'][]>();
    for (const insight of insights) {
      for (const nodeId of insight.nodeIds) {
        const bucket = markerMap.get(nodeId) ?? [];
        if (!bucket.includes(insight.type)) {
          bucket.push(insight.type);
        }
        markerMap.set(nodeId, bucket);
      }
    }

    // FR-G03-AC4: Build summary cards for all nodes
    const summaryCards = new Map<string, NodeSummaryCard>();
    for (const node of snapshot.nodes) {
      summaryCards.set(node.id, this.buildSummaryCard(node, snapshot, insights));
    }

    return {
      layout: 'force-directed',
      nodes: snapshot.nodes.map((node, index) => ({
        id: node.id,
        label: node.title,
        color: colorForType(node.type),
        size: 12 + (markerMap.get(node.id)?.length ?? 0) * 4,
        type: node.type,
        domain: node.domain,
        x: Math.cos(index) * 100,
        y: Math.sin(index) * 100,
        markers: [...(markerMap.get(node.id) ?? [])],
      })),
      edges: snapshot.edges.map((edge) => ({
        id: edge.id,
        source: edge.sourceId,
        target: edge.targetId,
        style: styleForEdge(edge.type),
        color: colorForEdge(edge.type),
        width: 1 + edge.strength * 3,
        type: edge.type,
      })),
      filters: {
        domains: [...filters.domains],
        types: [...filters.types],
        timeRange: filters.timeRange
          ? {
              from: filters.timeRange.from ? new Date(filters.timeRange.from) : undefined,
              to: filters.timeRange.to ? new Date(filters.timeRange.to) : undefined,
            }
          : undefined,
      },
      // FR-G03-AC2: Interaction capabilities
      interactions: {
        zoom: true,
        pan: true,
        nodeDrag: true,
        focusOnClick: true,
        summaryCardOnClick: true,
      },
      summaryCards,
    };
  }
}

/**
 * FR-G02-AC5: Convert an insight into a research task suggestion.
 */
function insightToResearchTask(insight: GraphInsight): InsightResearchTask | null {
  switch (insight.type) {
    case 'isolated_node':
      return {
        insightType: 'isolated_node',
        title: `补充孤立知识条目的关联关系`,
        description: `以下知识条目缺少关联支撑，建议调研相关领域并建立关联：${insight.summary}`,
        targetNodeIds: [...insight.nodeIds],
        priority: 'medium',
      };
    case 'bridge_node':
      return {
        insightType: 'bridge_node',
        title: `深化桥接节点的知识覆盖`,
        description: `以下知识条目连接多个主题群，是关键桥接节点，建议深化其覆盖范围：${insight.summary}`,
        targetNodeIds: [...insight.nodeIds],
        priority: 'low',
      };
    case 'sparse_community':
      return {
        insightType: 'sparse_community',
        title: `加强稀疏社区的内部关联`,
        description: `以下主题群内部关联薄弱，建议补充关联或深化研究：${insight.summary}`,
        targetNodeIds: [...insight.nodeIds],
        priority: 'high',
      };
    case 'unexpected_association':
      return {
        insightType: 'unexpected_association',
        title: `验证跨主题非显然关联`,
        description: `发现跨主题的非显然关联，建议验证其有效性：${insight.summary}`,
        targetNodeIds: [...insight.nodeIds],
        priority: 'medium',
      };
    default:
      return null;
  }
}

function buildAdjacency(snapshot: KnowledgeGraphSnapshot): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const node of snapshot.nodes) {
    adjacency.set(node.id, new Set());
  }

  for (const edge of snapshot.edges) {
    adjacency.get(edge.sourceId)?.add(edge.targetId);
    adjacency.get(edge.targetId)?.add(edge.sourceId);
  }

  return adjacency;
}

function findIsolatedNodes(
  snapshot: KnowledgeGraphSnapshot,
  adjacency: Map<string, Set<string>>
): GraphInsight[] {
  return snapshot.nodes
    .filter((node) => (adjacency.get(node.id)?.size ?? 0) === 0)
    .map((node) => ({
      type: 'isolated_node' as const,
      nodeIds: [node.id],
      score: 0.55,
      summary: `知识条目“${node.title}”处于孤立状态，缺少关联支撑。`,
    }));
}

function findBridgeNodes(
  snapshot: KnowledgeGraphSnapshot,
  adjacency: Map<string, Set<string>>,
  options: InsightOptions
): GraphInsight[] {
  const threshold = options.bridgeCentralityThreshold ?? 0.34;
  const insights: GraphInsight[] = [];
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));

  for (const node of snapshot.nodes) {
    const neighbors = Array.from(adjacency.get(node.id) ?? []);
    if (neighbors.length < 2) {
      continue;
    }

    const domains = new Set(
      neighbors
        .map((neighborId) => nodeById.get(neighborId)?.domain)
        .filter((domain): domain is string => Boolean(domain))
    );

    const score = Math.min(1, neighbors.length / Math.max(3, snapshot.nodes.length) + domains.size * 0.18);
    if (score >= threshold && domains.size >= 2) {
      insights.push({
        type: 'bridge_node',
        nodeIds: [node.id],
        score,
        summary: `知识条目“${node.title}”连接多个主题群，是桥接节点。`,
        metadata: {
          neighborCount: neighbors.length,
          domainCount: domains.size,
        },
      });
    }
  }

  return insights;
}

function findSparseCommunities(
  snapshot: KnowledgeGraphSnapshot,
  adjacency: Map<string, Set<string>>,
  options: InsightOptions
): GraphInsight[] {
  const threshold = options.sparseCommunityThreshold ?? 0.2;
  const byDomain = new Map<string, KnowledgeGraphNode[]>();

  for (const node of snapshot.nodes) {
    if (!node.domain) {
      continue;
    }
    const bucket = byDomain.get(node.domain) ?? [];
    bucket.push(node);
    byDomain.set(node.domain, bucket);
  }

  const insights: GraphInsight[] = [];
  for (const [domain, nodes] of byDomain.entries()) {
    if (nodes.length < 3) {
      continue;
    }

    const ids = new Set(nodes.map((node) => node.id));
    let actualLinks = 0;
    for (const node of nodes) {
      for (const neighbor of adjacency.get(node.id) ?? []) {
        if (ids.has(neighbor)) {
          actualLinks += 1;
        }
      }
    }

    const undirectedLinks = actualLinks / 2;
    const possibleLinks = (nodes.length * (nodes.length - 1)) / 2;
    const density = possibleLinks === 0 ? 0 : undirectedLinks / possibleLinks;

    if (density < threshold) {
      insights.push({
        type: 'sparse_community',
        nodeIds: nodes.map((node) => node.id),
        score: 1 - density,
        summary: `领域“${domain}”形成稀疏社区，条目之间支撑关系偏弱。`,
        metadata: {
          domain,
          density,
          size: nodes.length,
        },
      });
    }
  }

  return insights;
}

function findUnexpectedAssociations(
  snapshot: KnowledgeGraphSnapshot,
  adjacency: Map<string, Set<string>>,
  options: InsightOptions
): GraphInsight[] {
  const threshold = options.unexpectedAssociationThreshold ?? 0.5;
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));

  return snapshot.edges
    .map((edge) => {
      const left = nodeById.get(edge.sourceId);
      const right = nodeById.get(edge.targetId);
      if (!left || !right) {
        return null;
      }

      const sharedNeighbors = intersection(adjacency.get(left.id) ?? new Set(), adjacency.get(right.id) ?? new Set());
      const adamicAdar = sharedNeighbors.reduce((sum, neighborId) => {
        const degree = adjacency.get(neighborId)?.size ?? 1;
        return sum + 1 / Math.log1p(degree);
      }, 0);

      const crossDomainBonus = left.domain && right.domain && left.domain !== right.domain ? 0.22 : 0;
      const crossTypeBonus = left.type !== right.type ? 0.12 : 0;
      const score = Math.min(1, adamicAdar * 0.45 + edge.strength * 0.4 + crossDomainBonus + crossTypeBonus);

      if (score < threshold || (left.domain && right.domain && left.domain === right.domain && left.type === right.type)) {
        return null;
      }

      return {
        type: 'unexpected_association' as const,
        nodeIds: [left.id, right.id],
        score,
        summary: `“${left.title}”与“${right.title}”存在跨主题的非显然关联。`,
        metadata: {
          edgeId: edge.id,
          adamicAdar,
          edgeType: edge.type,
        },
      } satisfies GraphInsight;
    })
    .filter((insight): insight is NonNullable<typeof insight> => insight !== null);
}

function intersection(left: Set<string>, right: Set<string>): string[] {
  const result: string[] = [];
  for (const value of left) {
    if (right.has(value)) {
      result.push(value);
    }
  }
  return result;
}

function colorForType(type: KnowledgeGraphNode['type']): string {
  switch (type) {
    case 'fact':
      return '#4F46E5';
    case 'methodology':
      return '#0EA5E9';
    case 'decision':
      return '#F97316';
    case 'experience':
      return '#10B981';
    case 'intent':
      return '#8B5CF6';
    case 'meta':
      return '#64748B';
  }
}

function styleForEdge(type: KnowledgeGraphEdge['type']): GraphVisualizationEdge['style'] {
  switch (type) {
    case 'conflicts':
      return 'dashed';
    case 'semantic_neighbor':
      return 'dotted';
    default:
      return 'solid';
  }
}

function colorForEdge(type: KnowledgeGraphEdge['type']): string {
  switch (type) {
    case 'conflicts':
      return '#EF4444';
    case 'supersedes':
      return '#F59E0B';
    case 'depends_on':
      return '#06B6D4';
    case 'co_occurs':
      return '#94A3B8';
    case 'semantic_neighbor':
      return '#A855F7';
    default:
      return '#22C55E';
  }
}
