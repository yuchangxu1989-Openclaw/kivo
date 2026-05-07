import type { KnowledgeRepository } from '../repository/index.js';
import type { Association, AssociationType } from '../association/index.js';
import type { KnowledgeEntry, KnowledgeType } from '../types/index.js';

export interface KnowledgeGraphNode {
  id: string;
  title: string;
  type: KnowledgeType;
  domain?: string;
  status: KnowledgeEntry['status'];
  summary: string;
  sourceRef: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: KnowledgeEntry['metadata'];
}

export interface KnowledgeGraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: AssociationType | 'co_occurs' | 'semantic_neighbor';
  strength: number;
  signal: 'explicit' | 'source_cooccurrence' | 'semantic_proximity';
  metadata?: Record<string, unknown>;
}

export interface KnowledgeGraphSnapshot {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  updatedAt: Date;
}

export interface GraphFilter {
  domains?: string[];
  types?: KnowledgeType[];
  from?: Date;
  to?: Date;
}

export interface GraphBuildOptions {
  semanticThreshold?: number;
}

export class KnowledgeGraphBuilder {
  private cachedSnapshot: KnowledgeGraphSnapshot | null = null;

  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  async build(
    associations: Association[],
    options: GraphBuildOptions = {}
  ): Promise<KnowledgeGraphSnapshot> {
    const entries = await this.repository.findAll();
    const snapshot = buildSnapshot(entries, associations, this.now(), options);
    this.cachedSnapshot = snapshot;
    return snapshot;
  }

  /**
   * FR-G01-AC3: Incremental update — merge new/changed entries and associations
   * into an existing snapshot without full rebuild.
   */
  async incrementalUpdate(
    base: KnowledgeGraphSnapshot,
    changedEntries: KnowledgeEntry[],
    associations: Association[],
    options: GraphBuildOptions = {}
  ): Promise<KnowledgeGraphSnapshot> {
    const nodeMap = new Map(base.nodes.map((n) => [n.id, n]));
    const edgeMap = new Map(base.edges.map((e) => [e.id, e]));

    // Upsert changed nodes
    for (const entry of changedEntries) {
      nodeMap.set(entry.id, toNode(entry));
    }

    // Rebuild edges from associations (explicit signal)
    for (const association of associations) {
      const edge: KnowledgeGraphEdge = {
        id: makeEdgeId(association.sourceId, association.targetId, association.type),
        sourceId: association.sourceId,
        targetId: association.targetId,
        type: association.type,
        strength: clamp(association.strength),
        signal: 'explicit',
        metadata: association.metadata ? { ...association.metadata } : undefined,
      };
      if (nodeMap.has(edge.sourceId) && nodeMap.has(edge.targetId) && edge.sourceId !== edge.targetId) {
        const prev = edgeMap.get(edge.id);
        if (!prev || prev.strength < edge.strength) {
          edgeMap.set(edge.id, edge);
        }
      }
    }

    // Rebuild co-occurrence and semantic edges for changed entries
    const allEntries = Array.from(nodeMap.values());
    const changedIds = new Set(changedEntries.map((e) => e.id));
    const semanticThreshold = options.semanticThreshold ?? 0.78;

    // Fetch full entries for semantic comparison
    const fullEntries = await this.repository.findAll();
    const entryById = new Map(fullEntries.map((e) => [e.id, e]));

    // Source co-occurrence for changed entries
    const bySource = groupBy(fullEntries, (e) => `${e.source.type}::${e.source.reference}`);
    for (const bucket of bySource.values()) {
      const hasChanged = bucket.some((e) => changedIds.has(e.id));
      if (!hasChanged) continue;
      forEachPair(bucket, (a, b) => {
        const strength = clamp(0.45 + Math.min(a.confidence, b.confidence) * 0.2);
        const edgeId = makeUndirectedEdgeId(a.id, b.id, 'co_occurs');
        if (nodeMap.has(a.id) && nodeMap.has(b.id) && a.id !== b.id) {
          const prev = edgeMap.get(edgeId);
          if (!prev || prev.strength < strength) {
            edgeMap.set(edgeId, {
              id: edgeId,
              sourceId: a.id,
              targetId: b.id,
              type: 'co_occurs',
              strength,
              signal: 'source_cooccurrence',
            });
          }
        }
      });
    }

    // Semantic proximity for changed entries
    for (const changed of changedEntries) {
      for (const other of fullEntries) {
        if (changed.id === other.id) continue;
        const similarity = semanticSimilarity(changed, other);
        if (similarity < semanticThreshold) continue;
        const edgeId = makeUndirectedEdgeId(changed.id, other.id, 'semantic_neighbor');
        if (nodeMap.has(changed.id) && nodeMap.has(other.id)) {
          const prev = edgeMap.get(edgeId);
          if (!prev || prev.strength < similarity) {
            edgeMap.set(edgeId, {
              id: edgeId,
              sourceId: changed.id,
              targetId: other.id,
              type: 'semantic_neighbor',
              strength: clamp(similarity),
              signal: 'semantic_proximity',
              metadata: { overlap: lexicalOverlap(changed, other) },
            });
          }
        }
      }
    }

    // Remove edges referencing deleted nodes
    for (const [edgeId, edge] of edgeMap) {
      if (!nodeMap.has(edge.sourceId) || !nodeMap.has(edge.targetId)) {
        edgeMap.delete(edgeId);
      }
    }

    const snapshot: KnowledgeGraphSnapshot = {
      nodes: Array.from(nodeMap.values()).map(cloneNode),
      edges: Array.from(edgeMap.values()).sort((a, b) => a.id.localeCompare(b.id)).map(cloneEdge),
      updatedAt: new Date(this.now()),
    };
    this.cachedSnapshot = snapshot;
    return snapshot;
  }

  /**
   * FR-G01-AC4: API exposure — return the latest snapshot for external consumption.
   */
  getSnapshot(): KnowledgeGraphSnapshot | null {
    return this.cachedSnapshot ? {
      nodes: this.cachedSnapshot.nodes.map(cloneNode),
      edges: this.cachedSnapshot.edges.map(cloneEdge),
      updatedAt: new Date(this.cachedSnapshot.updatedAt),
    } : null;
  }

  async filter(
    snapshot: KnowledgeGraphSnapshot,
    filter: GraphFilter = {}
  ): Promise<KnowledgeGraphSnapshot> {
    return filterSnapshot(snapshot, filter, this.now());
  }
}

export function buildSnapshot(
  entries: KnowledgeEntry[],
  associations: Association[],
  timestamp: Date,
  options: GraphBuildOptions = {}
): KnowledgeGraphSnapshot {
  const nodes = entries.map(toNode);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = new Map<string, KnowledgeGraphEdge>();

  const registerEdge = (edge: KnowledgeGraphEdge) => {
    if (!nodeById.has(edge.sourceId) || !nodeById.has(edge.targetId) || edge.sourceId === edge.targetId) {
      return;
    }

    const previous = edges.get(edge.id);
    if (!previous || previous.strength < edge.strength) {
      edges.set(edge.id, cloneEdge(edge));
    }
  };

  for (const association of associations) {
    registerEdge({
      id: makeEdgeId(association.sourceId, association.targetId, association.type),
      sourceId: association.sourceId,
      targetId: association.targetId,
      type: association.type,
      strength: clamp(association.strength),
      signal: 'explicit',
      metadata: association.metadata ? { ...association.metadata } : undefined,
    });
  }

  const bySource = groupBy(entries, (entry) => `${entry.source.type}::${entry.source.reference}`);
  for (const bucket of bySource.values()) {
    forEachPair(bucket, (a, b) => {
      const strength = clamp(0.45 + Math.min(a.confidence, b.confidence) * 0.2);
      registerEdge({
        id: makeUndirectedEdgeId(a.id, b.id, 'co_occurs'),
        sourceId: a.id,
        targetId: b.id,
        type: 'co_occurs',
        strength,
        signal: 'source_cooccurrence',
      });
    });
  }

  const semanticThreshold = options.semanticThreshold ?? 0.78;
  forEachPair(entries, (a, b) => {
    const similarity = semanticSimilarity(a, b);
    if (similarity < semanticThreshold) {
      return;
    }

    registerEdge({
      id: makeUndirectedEdgeId(a.id, b.id, 'semantic_neighbor'),
      sourceId: a.id,
      targetId: b.id,
      type: 'semantic_neighbor',
      strength: clamp(similarity),
      signal: 'semantic_proximity',
      metadata: {
        overlap: lexicalOverlap(a, b),
      },
    });
  });

  return {
    nodes: nodes.map(cloneNode),
    edges: Array.from(edges.values())
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(cloneEdge),
    updatedAt: new Date(timestamp),
  };
}

export function filterSnapshot(
  snapshot: KnowledgeGraphSnapshot,
  filter: GraphFilter,
  timestamp: Date
): KnowledgeGraphSnapshot {
  const allowedDomain = filter.domains && filter.domains.length > 0 ? new Set(filter.domains) : null;
  const allowedType = filter.types && filter.types.length > 0 ? new Set(filter.types) : null;

  const nodes = snapshot.nodes.filter((node) => {
    if (allowedDomain && (!node.domain || !allowedDomain.has(node.domain))) {
      return false;
    }
    if (allowedType && !allowedType.has(node.type)) {
      return false;
    }
    if (filter.from && node.updatedAt < filter.from) {
      return false;
    }
    if (filter.to && node.updatedAt > filter.to) {
      return false;
    }
    return true;
  });

  const allowedIds = new Set(nodes.map((node) => node.id));
  const edges = snapshot.edges.filter(
    (edge) => allowedIds.has(edge.sourceId) && allowedIds.has(edge.targetId)
  );

  return {
    nodes: nodes.map(cloneNode),
    edges: edges.map(cloneEdge),
    updatedAt: new Date(timestamp),
  };
}

function toNode(entry: KnowledgeEntry): KnowledgeGraphNode {
  return {
    id: entry.id,
    title: entry.title,
    type: entry.type,
    domain: entry.domain,
    status: entry.status,
    summary: entry.summary,
    sourceRef: `${entry.source.type}:${entry.source.reference}`,
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  };
}

function semanticSimilarity(a: KnowledgeEntry, b: KnowledgeEntry): number {
  const overlap = lexicalOverlap(a, b);
  const sameDomain = a.domain && b.domain && a.domain === b.domain ? 0.12 : 0;
  const sameType = a.type === b.type ? 0.08 : 0;
  return clamp(overlap + sameDomain + sameType);
}

function lexicalOverlap(a: KnowledgeEntry, b: KnowledgeEntry): number {
  const left = tokenize(`${a.title} ${a.summary} ${a.content}`);
  const right = tokenize(`${b.title} ${b.summary} ${b.content}`);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(left.size, right.size);
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[\p{P}\p{S}]+/gu, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = map.get(key) ?? [];
    bucket.push(item);
    map.set(key, bucket);
  }
  return map;
}

function forEachPair<T>(items: T[], callback: (left: T, right: T) => void): void {
  for (let index = 0; index < items.length; index += 1) {
    for (let inner = index + 1; inner < items.length; inner += 1) {
      callback(items[index], items[inner]);
    }
  }
}

function makeEdgeId(sourceId: string, targetId: string, type: string): string {
  return `${sourceId}->${targetId}:${type}`;
}

function makeUndirectedEdgeId(sourceId: string, targetId: string, type: string): string {
  return [sourceId, targetId].sort().join('<->') + `:${type}`;
}

function cloneNode(node: KnowledgeGraphNode): KnowledgeGraphNode {
  return {
    ...node,
    createdAt: new Date(node.createdAt),
    updatedAt: new Date(node.updatedAt),
    metadata: node.metadata ? { ...node.metadata } : undefined,
  };
}

function cloneEdge(edge: KnowledgeGraphEdge): KnowledgeGraphEdge {
  return {
    ...edge,
    metadata: edge.metadata ? { ...edge.metadata } : undefined,
  };
}

function clamp(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
