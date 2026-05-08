/**
 * GET /api/v1/artifacts — List analysis artifacts with review queue
 * POST /api/v1/artifacts/[id]/review — Review a candidate (separate route)
 * FR-L02: Analysis Artifact Review
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';

export interface ArtifactListItem {
  id: string;
  sourceId: string;
  status: 'pending_review' | 'approved' | 'rejected' | 'ready';
  confidence: number;
  claimsCount: number;
  entityCount: number;
  conceptCount: number;
  conflictCount: number;
  gapCount: number;
  researchQueryCount: number;
  reviewProgress: { total: number; reviewed: number };
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactDetail extends ArtifactListItem {
  extractedClaims: Array<{ id: string; text: string; confidence: number; type?: string }>;
  entityCandidates: Array<{ id: string; label: string; confidence: number }>;
  conceptCandidates: Array<{ id: string; label: string; confidence: number }>;
  linkCandidates: Array<{ id: string; label: string; confidence: number }>;
  conflictCandidates: Array<{ id: string; label: string; confidence: number }>;
  gapCandidates: Array<{ id: string; label: string; confidence: number }>;
  recommendedResearchQueries: string[];
  candidateDecisions: Array<{
    candidateId: string;
    action: 'approved' | 'rejected' | 'edited';
    editedValue?: string;
    reviewedAt: string;
  }>;
}

// ─── In-memory demo store ────────────────────────────────────────────────────

const STORE_KEY = '__kivo_artifact_store__';

type GlobalWithArtifacts = typeof globalThis & { [STORE_KEY]?: ArtifactDetail[] };

function getArtifacts(): ArtifactDetail[] {
  const scope = globalThis as GlobalWithArtifacts;
  if (!scope[STORE_KEY]) {
    scope[STORE_KEY] = seedArtifacts();
  }
  return scope[STORE_KEY]!;
}

function seedArtifacts(): ArtifactDetail[] {
  const now = Date.now();
  return [
    {
      id: 'art-001',
      sourceId: 'conv-2024-001',
      status: 'pending_review',
      confidence: 0.45,
      claimsCount: 3,
      entityCount: 2,
      conceptCount: 1,
      conflictCount: 1,
      gapCount: 1,
      researchQueryCount: 2,
      reviewProgress: { total: 4, reviewed: 1 },
      createdAt: new Date(now - 2 * 3600_000).toISOString(),
      updatedAt: new Date(now - 1800_000).toISOString(),
      extractedClaims: [
        { id: 'claim-1', text: 'REST API 应使用 URL 路径版本控制', confidence: 0.9, type: 'fact' },
        { id: 'claim-2', text: '微服务间通信推荐 gRPC', confidence: 0.75, type: 'methodology' },
        { id: 'claim-3', text: '数据库迁移应使用蓝绿部署', confidence: 0.5, type: 'experience' },
      ],
      entityCandidates: [
        { id: 'ent-1', label: 'REST API 版本管理', confidence: 0.88 },
        { id: 'ent-2', label: 'gRPC 通信协议', confidence: 0.72 },
      ],
      conceptCandidates: [
        { id: 'con-1', label: '服务间通信模式', confidence: 0.8 },
      ],
      linkCandidates: [],
      conflictCandidates: [
        { id: 'conf-1', label: '与现有"Header 版本控制"条目冲突', confidence: 0.65 },
      ],
      gapCandidates: [
        { id: 'gap-1', label: '缺少 GraphQL 版本管理策略', confidence: 0.7 },
      ],
      recommendedResearchQueries: ['GraphQL 版本管理最佳实践', 'gRPC vs REST 性能对比'],
      candidateDecisions: [
        { candidateId: 'claim-1', action: 'approved', reviewedAt: new Date(now - 1800_000).toISOString() },
      ],
    },
    {
      id: 'art-002',
      sourceId: 'doc-import-003',
      status: 'pending_review',
      confidence: 0.55,
      claimsCount: 2,
      entityCount: 1,
      conceptCount: 2,
      conflictCount: 0,
      gapCount: 2,
      researchQueryCount: 1,
      reviewProgress: { total: 3, reviewed: 0 },
      createdAt: new Date(now - 5 * 3600_000).toISOString(),
      updatedAt: new Date(now - 5 * 3600_000).toISOString(),
      extractedClaims: [
        { id: 'claim-4', text: '前端状态管理应优先使用 React Context', confidence: 0.6, type: 'methodology' },
        { id: 'claim-5', text: 'Zustand 适合中大型应用', confidence: 0.8, type: 'experience' },
      ],
      entityCandidates: [
        { id: 'ent-3', label: '前端状态管理', confidence: 0.9 },
      ],
      conceptCandidates: [
        { id: 'con-2', label: '状态管理模式', confidence: 0.85 },
        { id: 'con-3', label: '组件通信策略', confidence: 0.6 },
      ],
      linkCandidates: [],
      conflictCandidates: [],
      gapCandidates: [
        { id: 'gap-2', label: '缺少 Server State 管理方案', confidence: 0.75 },
        { id: 'gap-3', label: '缺少跨 Tab 状态同步策略', confidence: 0.5 },
      ],
      recommendedResearchQueries: ['React Server Components 状态管理'],
      candidateDecisions: [],
    },
    {
      id: 'art-003',
      sourceId: 'conv-2024-005',
      status: 'approved',
      confidence: 0.92,
      claimsCount: 1,
      entityCount: 1,
      conceptCount: 0,
      conflictCount: 0,
      gapCount: 0,
      researchQueryCount: 0,
      reviewProgress: { total: 1, reviewed: 1 },
      createdAt: new Date(now - 24 * 3600_000).toISOString(),
      updatedAt: new Date(now - 20 * 3600_000).toISOString(),
      extractedClaims: [
        { id: 'claim-6', text: 'CI/CD 流水线应包含安全扫描步骤', confidence: 0.95, type: 'fact' },
      ],
      entityCandidates: [
        { id: 'ent-4', label: 'CI/CD 安全实践', confidence: 0.93 },
      ],
      conceptCandidates: [],
      linkCandidates: [],
      conflictCandidates: [],
      gapCandidates: [],
      recommendedResearchQueries: [],
      candidateDecisions: [
        { candidateId: 'claim-6', action: 'approved', reviewedAt: new Date(now - 20 * 3600_000).toISOString() },
      ],
    },
  ];
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || undefined;
    const artifacts = getArtifacts();

    let filtered = artifacts;
    if (status) {
      filtered = artifacts.filter(a => a.status === status);
    }

    const list: ArtifactListItem[] = filtered.map(a => ({
      id: a.id,
      sourceId: a.sourceId,
      status: a.status,
      confidence: a.confidence,
      claimsCount: a.claimsCount,
      entityCount: a.entityCount,
      conceptCount: a.conceptCount,
      conflictCount: a.conflictCount,
      gapCount: a.gapCount,
      researchQueryCount: a.researchQueryCount,
      reviewProgress: a.reviewProgress,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }));

    const response: ApiResponse<ArtifactListItem[]> = {
      data: list,
      meta: { total: list.length, page: 1, pageSize: list.length },
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError((err as Error).message);
  }
}
