/**
 * KIVO Web — Centralized API Client
 *
 * Typed wrappers for all backend API endpoints.
 * Uses apiFetch from client-api.ts under the hood.
 */

import { apiFetch } from './client-api';
import type {
  ApiResponse,
  DashboardSummary,
  SearchParams,
  KnowledgeListParams,
  ContentEditRequest,
  StatusUpdateRequest,
  ConflictResolveRequest,
} from '@/types';

// ─── Knowledge Entry Types ───────────────────────────────────────────────────

export interface KnowledgeEntry {
  id: string;
  type: string;
  title: string;
  content: string;
  summary: string;
  status: string;
  confidence: number;
  domain?: string;
  tags: string[];
  source?: {
    type?: string;
    reference?: string;
    timestamp?: string;
    agent?: string;
    context?: string;
  };
  metadata?: {
    tags?: string[];
    domainData?: {
      sourceDocument?: string;
      sourceLocation?: string;
    };
  };
  similarSentences?: string[] | string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CreateEntryPayload {
  title: string;
  content: string;
  type?: string;
  domain?: string;
  summary?: string;
  confidence?: number;
  sourceDocument?: string;
  sourceLocation?: string;
}

// ─── Search Types ────────────────────────────────────────────────────────────

export interface SearchResult {
  id: string;
  type: string;
  title: string;
  summary: string;
  content: string;
  status: string;
  score: number;
  highlights: string[];
  createdAt?: string;
  metadata?: { tags?: string[] };
}

// ─── Graph Types ─────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  domain?: string;
  tags: string[];
  createdAt: string;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  strength: number;
  signal: string;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  insights?: {
    isolatedNodeIds: string[];
    bridgeNodeIds: string[];
  };
  updatedAt: string;
  meta?: {
    totalNodes: number;
    totalEdges: number;
    displayedNodes: number;
  };
}

// ─── Stats Types ─────────────────────────────────────────────────────────────

export interface StatsData {
  totalEntries: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  graph: { nodes: number; edges: number };
  dictionaryTerms: number;
  lastUpdated: string | null;
  recentActivity: Array<{
    id: string;
    title: string;
    type: string;
    timestamp: string;
  }>;
}

// ─── API Functions ───────────────────────────────────────────────────────────

/** Knowledge Entries — List with pagination and filtering */
export async function fetchEntries(params?: KnowledgeListParams): Promise<ApiResponse<KnowledgeEntry[]>> {
  const search = new URLSearchParams();
  if (params?.type) search.set('type', params.type);
  if (params?.status) search.set('status', params.status);
  if (params?.domain) search.set('domain', params.domain);
  if (params?.source) search.set('source', params.source);
  if (params?.sort) search.set('sort', params.sort);
  if (params?.page) search.set('page', String(params.page));
  if (params?.pageSize) search.set('pageSize', String(params.pageSize));
  const qs = search.toString();
  return apiFetch<ApiResponse<KnowledgeEntry[]>>(`/api/v1/knowledge${qs ? `?${qs}` : ''}`);
}

/** Knowledge Entries — Get single entry by ID */
export async function fetchEntry(id: string): Promise<ApiResponse<KnowledgeEntry>> {
  return apiFetch<ApiResponse<KnowledgeEntry>>(`/api/v1/knowledge/${id}`);
}

/** Knowledge Entries — Create new entry */
export async function createEntry(payload: CreateEntryPayload): Promise<ApiResponse<KnowledgeEntry>> {
  return apiFetch<ApiResponse<KnowledgeEntry>>('/api/v1/knowledge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Knowledge Entries — Update entry fields */
export async function updateEntry(id: string, fields: Partial<KnowledgeEntry>): Promise<ApiResponse<KnowledgeEntry>> {
  return apiFetch<ApiResponse<KnowledgeEntry>>(`/api/v1/knowledge/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

/** Knowledge Entries — Update content with version control */
export async function updateEntryContent(id: string, payload: ContentEditRequest): Promise<ApiResponse<KnowledgeEntry>> {
  return apiFetch<ApiResponse<KnowledgeEntry>>(`/api/v1/knowledge/${id}/content`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

/** Knowledge Entries — Update status */
export async function updateEntryStatus(id: string, payload: StatusUpdateRequest): Promise<ApiResponse<KnowledgeEntry>> {
  return apiFetch<ApiResponse<KnowledgeEntry>>(`/api/v1/knowledge/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

/** Semantic Search */
export async function searchKnowledge(params: SearchParams): Promise<ApiResponse<SearchResult[]>> {
  const search = new URLSearchParams();
  search.set('q', params.q);
  if (params.type) search.set('type', params.type);
  if (params.status) search.set('status', params.status);
  if (params.page) search.set('page', String(params.page));
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
  return apiFetch<ApiResponse<SearchResult[]>>(`/api/v1/search?${search.toString()}`);
}

/** Knowledge Graph — Get snapshot */
export async function fetchGraph(params?: {
  domain?: string;
  type?: string;
  since?: string;
  limit?: number;
}): Promise<ApiResponse<GraphSnapshot>> {
  const search = new URLSearchParams();
  if (params?.domain) search.set('domain', params.domain);
  if (params?.type) search.set('type', params.type);
  if (params?.since) search.set('since', params.since);
  if (params?.limit) search.set('limit', String(params.limit));
  const qs = search.toString();
  return apiFetch<ApiResponse<GraphSnapshot>>(`/api/v1/graph${qs ? `?${qs}` : ''}`);
}

/** Dashboard Summary */
export async function fetchDashboardSummary(): Promise<ApiResponse<DashboardSummary>> {
  return apiFetch<ApiResponse<DashboardSummary>>('/api/v1/dashboard/summary');
}

/** Stats — Aggregated statistics */
export async function fetchStats(): Promise<ApiResponse<StatsData>> {
  return apiFetch<ApiResponse<StatsData>>('/api/v1/stats');
}

/** Conflicts — List unresolved */
export async function fetchConflicts(): Promise<ApiResponse<unknown[]>> {
  return apiFetch<ApiResponse<unknown[]>>('/api/v1/conflicts');
}

/** Conflicts — Resolve */
export async function resolveConflict(id: string, payload: ConflictResolveRequest): Promise<ApiResponse<unknown>> {
  return apiFetch<ApiResponse<unknown>>(`/api/v1/conflicts/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Governance — List reports */
export async function fetchGovernanceReports(): Promise<ApiResponse<unknown[]>> {
  return apiFetch<ApiResponse<unknown[]>>('/api/v1/governance/reports');
}

/** Governance — Rollback */
export async function rollbackGovernance(id: string): Promise<ApiResponse<unknown>> {
  return apiFetch<ApiResponse<unknown>>(`/api/v1/governance/${id}/rollback`, {
    method: 'POST',
  });
}

/** Wiki Materials — List */
export async function fetchWikiMaterials(): Promise<ApiResponse<unknown[]>> {
  return apiFetch<ApiResponse<unknown[]>>('/api/v1/wiki/materials');
}

/** Wiki Materials — Upload */
export async function uploadWikiMaterial(formData: FormData): Promise<ApiResponse<unknown>> {
  const response = await fetch('/api/v1/wiki/upload', {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => null);
    throw new Error(err?.error?.message || `Upload failed: ${response.status}`);
  }
  return response.json();
}
