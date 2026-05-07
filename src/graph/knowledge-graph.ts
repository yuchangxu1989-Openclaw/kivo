import type { KnowledgeEntry } from '../types/index.js';
import type { Association } from '../association/association-types.js';
import type { GraphNode, GraphEdge, GraphSnapshot, GraphMetadata, EdgeSource } from './graph-types.js';

export interface KnowledgeGraphOptions {
  semanticThreshold?: number;
}

export class KnowledgeGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly adjacency = new Map<string, Set<string>>();
  private readonly semanticThreshold: number;

  constructor(options: KnowledgeGraphOptions = {}) {
    this.semanticThreshold = options.semanticThreshold ?? 0.8;
  }

  addEntry(entry: KnowledgeEntry): GraphNode {
    const node: GraphNode = {
      entryId: entry.id,
      type: entry.type,
      title: entry.title,
      domain: entry.domain,
      tags: [...entry.tags],
    };
    this.nodes.set(entry.id, node);
    if (!this.adjacency.has(entry.id)) {
      this.adjacency.set(entry.id, new Set());
    }
    return { ...node, tags: [...node.tags] };
  }

  removeEntry(entryId: string): boolean {
    if (!this.nodes.has(entryId)) {
      return false;
    }
    const adj = this.adjacency.get(entryId);
    if (adj) {
      for (const edgeKey of adj) {
        const edge = this.edges.get(edgeKey);
        if (edge) {
          const otherId = edge.sourceId === entryId ? edge.targetId : edge.sourceId;
          this.adjacency.get(otherId)?.delete(edgeKey);
        }
        this.edges.delete(edgeKey);
      }
    }
    this.adjacency.delete(entryId);
    this.nodes.delete(entryId);
    return true;
  }

  addExplicitEdge(association: Association): GraphEdge {
    return this.addEdge(association.sourceId, association.targetId, association.type, 'explicit', association.strength);
  }

  addCoOccurrenceEdge(entryId1: string, entryId2: string, strength: number): GraphEdge {
    return this.addEdge(entryId1, entryId2, 'supplements', 'co_occurrence', strength);
  }

  addSemanticEdge(entryId1: string, entryId2: string, similarity: number): GraphEdge | null {
    if (similarity < this.semanticThreshold) {
      return null;
    }
    return this.addEdge(entryId1, entryId2, 'supplements', 'semantic', similarity);
  }

  removeEdge(sourceId: string, targetId: string, edgeSource?: string): boolean {
    if (edgeSource) {
      const key = this.edgeKey(sourceId, targetId, edgeSource);
      if (!this.edges.has(key)) return false;
      this.edges.delete(key);
      this.adjacency.get(sourceId)?.delete(key);
      this.adjacency.get(targetId)?.delete(key);
      return true;
    }
    // No edgeSource specified: remove all edges between this pair
    const prefix = `${sourceId}::${targetId}::`;
    let removed = false;
    for (const key of Array.from(this.edges.keys())) {
      if (key.startsWith(prefix)) {
        this.edges.delete(key);
        this.adjacency.get(sourceId)?.delete(key);
        this.adjacency.get(targetId)?.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  getNode(entryId: string): GraphNode | undefined {
    const node = this.nodes.get(entryId);
    return node ? { ...node, tags: [...node.tags] } : undefined;
  }

  getNeighbors(entryId: string): GraphNode[] {
    const adj = this.adjacency.get(entryId);
    if (!adj) {
      return [];
    }
    const neighborIds = new Set<string>();
    for (const edgeKey of adj) {
      const edge = this.edges.get(edgeKey);
      if (edge) {
        neighborIds.add(edge.sourceId === entryId ? edge.targetId : edge.sourceId);
      }
    }
    return Array.from(neighborIds)
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined)
      .map((n) => ({ ...n, tags: [...n.tags] }));
  }

  getEdges(entryId: string): GraphEdge[] {
    const adj = this.adjacency.get(entryId);
    if (!adj) {
      return [];
    }
    return Array.from(adj)
      .map((key) => this.edges.get(key))
      .filter((e): e is GraphEdge => e !== undefined)
      .map((e) => ({ ...e }));
  }

  getDegree(entryId: string): number {
    return this.adjacency.get(entryId)?.size ?? 0;
  }

  snapshot(): GraphSnapshot {
    const domains = new Set<string>();
    const nodes: GraphNode[] = [];
    for (const node of this.nodes.values()) {
      nodes.push({ ...node, tags: [...node.tags] });
      if (node.domain) {
        domains.add(node.domain);
      }
    }
    const edges = Array.from(this.edges.values()).map((e) => ({ ...e }));
    const metadata: GraphMetadata = {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      builtAt: new Date(),
      domains: Array.from(domains).sort(),
    };
    return { nodes, edges, metadata };
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.size;
  }

  private addEdge(
    sourceId: string,
    targetId: string,
    associationType: Association['type'],
    edgeSource: EdgeSource,
    weight: number,
  ): GraphEdge {
    const key = this.edgeKey(sourceId, targetId, edgeSource);
    const edge: GraphEdge = { sourceId, targetId, associationType, edgeSource, weight };
    this.edges.set(key, edge);
    if (!this.adjacency.has(sourceId)) {
      this.adjacency.set(sourceId, new Set());
    }
    if (!this.adjacency.has(targetId)) {
      this.adjacency.set(targetId, new Set());
    }
    this.adjacency.get(sourceId)!.add(key);
    this.adjacency.get(targetId)!.add(key);
    return { ...edge };
  }

  private edgeKey(sourceId: string, targetId: string, edgeSource?: string): string {
    return edgeSource
      ? `${sourceId}::${targetId}::${edgeSource}`
      : `${sourceId}::${targetId}`;
  }
}
