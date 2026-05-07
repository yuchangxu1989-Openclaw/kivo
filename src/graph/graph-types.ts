import type { KnowledgeEntry, KnowledgeType } from '../types/index.js';
import type { AssociationType } from '../association/association-types.js';

export type EdgeSource = 'explicit' | 'co_occurrence' | 'semantic';

export interface GraphNode {
  entryId: string;
  type: KnowledgeType;
  title: string;
  domain?: string;
  tags: string[];
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  associationType: AssociationType;
  edgeSource: EdgeSource;
  weight: number;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: GraphMetadata;
}

export interface GraphMetadata {
  nodeCount: number;
  edgeCount: number;
  builtAt: Date;
  domains: string[];
}

export type InsightType =
  | 'isolated_node'
  | 'bridge_node'
  | 'sparse_community'
  | 'unexpected_link';

export type ImportanceLevel = 'high' | 'medium' | 'low';

export interface Insight {
  id: string;
  type: InsightType;
  description: string;
  importance: ImportanceLevel;
  affectedNodeIds: string[];
  metadata?: Record<string, unknown>;
}

export interface InsightResult {
  insights: Insight[];
  analyzedAt: Date;
}

export interface GraphFilter {
  domains?: string[];
  types?: KnowledgeType[];
  fromDate?: Date;
  toDate?: Date;
}

export interface SerializedGraph {
  nodes: SerializedNode[];
  edges: SerializedEdge[];
  insights: SerializedInsight[];
  metadata: SerializedMetadata;
}

export interface SerializedNode {
  id: string;
  type: KnowledgeType;
  title: string;
  domain?: string;
  tags: string[];
  insightMarkers: InsightType[];
}

export interface SerializedEdge {
  source: string;
  target: string;
  associationType: AssociationType;
  edgeSource: EdgeSource;
  weight: number;
}

export interface SerializedInsight {
  id: string;
  type: InsightType;
  description: string;
  importance: ImportanceLevel;
  affectedNodeIds: string[];
}

export interface SerializedMetadata {
  nodeCount: number;
  edgeCount: number;
  insightCount: number;
  builtAt: string;
  domains: string[];
  filter?: GraphFilter;
}
