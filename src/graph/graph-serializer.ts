import type { KnowledgeGraph } from './knowledge-graph.js';
import type { InsightResult, GraphFilter, SerializedGraph, SerializedNode, SerializedEdge, SerializedInsight, SerializedMetadata, InsightType } from './graph-types.js';

export class GraphSerializer {
  serialize(graph: KnowledgeGraph, insights: InsightResult, filter?: GraphFilter): SerializedGraph {
    const snap = graph.snapshot();

    const insightNodeMarkers = new Map<string, Set<InsightType>>();
    for (const insight of insights.insights) {
      for (const nodeId of insight.affectedNodeIds) {
        if (!insightNodeMarkers.has(nodeId)) {
          insightNodeMarkers.set(nodeId, new Set());
        }
        insightNodeMarkers.get(nodeId)!.add(insight.type);
      }
    }

    let filteredNodeIds: Set<string> | null = null;
    if (filter) {
      filteredNodeIds = new Set<string>();
      for (const node of snap.nodes) {
        if (filter.domains && node.domain && !filter.domains.includes(node.domain)) {
          continue;
        }
        if (filter.types && !filter.types.includes(node.type)) {
          continue;
        }
        filteredNodeIds.add(node.entryId);
      }
    }

    const nodes: SerializedNode[] = snap.nodes
      .filter((n) => !filteredNodeIds || filteredNodeIds.has(n.entryId))
      .map((node) => ({
        id: node.entryId,
        type: node.type,
        title: node.title,
        domain: node.domain,
        tags: [...node.tags],
        insightMarkers: Array.from(insightNodeMarkers.get(node.entryId) ?? []),
      }));

    const nodeIdSet = new Set(nodes.map((n) => n.id));

    const edges: SerializedEdge[] = snap.edges
      .filter((e) => nodeIdSet.has(e.sourceId) && nodeIdSet.has(e.targetId))
      .map((edge) => ({
        source: edge.sourceId,
        target: edge.targetId,
        associationType: edge.associationType,
        edgeSource: edge.edgeSource,
        weight: edge.weight,
      }));

    const serializedInsights: SerializedInsight[] = insights.insights
      .filter((i) => i.affectedNodeIds.some((id) => nodeIdSet.has(id)))
      .map((insight) => ({
        id: insight.id,
        type: insight.type,
        description: insight.description,
        importance: insight.importance,
        affectedNodeIds: insight.affectedNodeIds.filter((id) => nodeIdSet.has(id)),
      }));

    const domains = new Set<string>();
    for (const node of nodes) {
      if (node.domain) {
        domains.add(node.domain);
      }
    }

    const metadata: SerializedMetadata = {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      insightCount: serializedInsights.length,
      builtAt: new Date().toISOString(),
      domains: Array.from(domains).sort(),
      filter,
    };

    return { nodes, edges, insights: serializedInsights, metadata };
  }
}
