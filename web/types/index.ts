/**
 * Web API Layer — Shared Types
 * Unified response/error format per arc42 §8.6
 */

// ─── API Response Types ──────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  meta?: {
    total: number;
    page: number;
    pageSize: number;
    totalPages?: number;
  };
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface WriteResponse<T> {
  data: T;
  meta: {
    version: number;
    requestId: string;
  };
}

export interface VersionConflictError {
  error: {
    code: 'VERSION_CONFLICT';
    message: string;
    details: {
      currentVersion: number;
      expectedVersion: number;
      requestId: string;
    };
  };
}

// ─── Write Request Protocol ──────────────────────────────────────────────────

export interface WriteRequestFields {
  expectedVersion: number;
  requestId: string;
}

// ─── Dashboard Types ─────────────────────────────────────────────────────────

export interface DashboardMetricTrend {
  percent: number;
  direction: 'up' | 'down' | 'flat';
  current: number;
  previous: number;
}

export interface DashboardSummary {
  totalEntries: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  activeByType: Record<string, number>;
  graph: {
    nodes: number;
    edges: number;
  };
  growth: {
    last7Days: Array<{
      date: string;
      count: number;
    }>;
  };
  confidenceBuckets: {
    high: number;
    medium: number;
    low: number;
    unknown: number;
  };
  health: {
    pendingCount: number;
    unresolvedConflicts: number;
  };
  searchHitRate: {
    current: number;
    previous: number;
  };
  nextAction: {
    title: string;
    description: string;
    href: string;
    tone: 'default' | 'warning' | 'success';
  };
  trends: {
    totalEntries: DashboardMetricTrend;
    pendingCount: DashboardMetricTrend;
    unresolvedConflicts: DashboardMetricTrend;
    typeCount: DashboardMetricTrend;
    searchHitRate: DashboardMetricTrend;
  };
}

// ─── Knowledge List Query Params ─────────────────────────────────────────────

export interface KnowledgeListParams {
  type?: string;
  status?: string;
  domain?: string;
  source?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

// ─── Search Params ───────────────────────────────────────────────────────────

export interface SearchParams {
  q: string;
  type?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface ConflictResolveRequest extends WriteRequestFields {
  strategy: 'newer-wins' | 'confidence-wins' | 'manual' | 'keep-a' | 'keep-b' | 'merge' | 'archive-both';
  winnerId?: string;
  operator?: string;
  reason?: string;
  mergedContent?: string;
}

// ─── Status Update Request ───────────────────────────────────────────────────

export interface StatusUpdateRequest extends WriteRequestFields {
  status: 'deprecated' | 'active' | 'archived';
}

// ─── Content Edit Request ────────────────────────────────────────────────────

export interface ContentEditRequest extends WriteRequestFields {
  content: string;
  summary?: string;
}

export interface LoginRequest {
  identity: string;
  password: string;
}
