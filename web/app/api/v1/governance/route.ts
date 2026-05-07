/**
 * GET /api/v1/governance — Intent governance statistics & report history
 * POST /api/v1/governance/batch — Batch operations (archive/re-evaluate)
 * FR-W13
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';

export interface GovernanceTheme {
  id: string;
  topic: string;
  count: number;
  trend: 'up' | 'down' | 'flat';
  lastSeen: string;
}

export interface GovernanceReport {
  id: string;
  title: string;
  summary: string;
  status: 'completed' | 'in_progress' | 'archived';
  issuesFound: number;
  issuesResolved: number;
  createdAt: string;
}

export interface GovernanceData {
  themes: GovernanceTheme[];
  reports: GovernanceReport[];
  stats: {
    totalIntents: number;
    activeIntents: number;
    archivedIntents: number;
    pendingReview: number;
    avgConfidence: number;
  };
}

function seedGovernanceData(): GovernanceData {
  const now = Date.now();
  return {
    themes: [
      { id: 'th-1', topic: 'API 设计规范', count: 23, trend: 'up', lastSeen: new Date(now - 3600_000).toISOString() },
      { id: 'th-2', topic: '数据库优化', count: 18, trend: 'flat', lastSeen: new Date(now - 7200_000).toISOString() },
      { id: 'th-3', topic: '前端架构', count: 15, trend: 'up', lastSeen: new Date(now - 1800_000).toISOString() },
      { id: 'th-4', topic: '安全合规', count: 12, trend: 'down', lastSeen: new Date(now - 14400_000).toISOString() },
      { id: 'th-5', topic: '测试策略', count: 9, trend: 'flat', lastSeen: new Date(now - 28800_000).toISOString() },
      { id: 'th-6', topic: '部署流程', count: 7, trend: 'up', lastSeen: new Date(now - 43200_000).toISOString() },
      { id: 'th-7', topic: '监控告警', count: 5, trend: 'down', lastSeen: new Date(now - 86400_000).toISOString() },
      { id: 'th-8', topic: '文档规范', count: 4, trend: 'flat', lastSeen: new Date(now - 172800_000).toISOString() },
    ],
    reports: [
      { id: 'rpt-1', title: '意图覆盖度周报 #12', summary: '本周新增 8 条意图，覆盖率提升至 78%。发现 3 条重复意图待合并。', status: 'completed', issuesFound: 5, issuesResolved: 4, createdAt: new Date(now - 86400_000).toISOString() },
      { id: 'rpt-2', title: '冲突意图清理报告', summary: '清理 12 条过期意图，合并 4 组语义重复意图。', status: 'completed', issuesFound: 16, issuesResolved: 16, createdAt: new Date(now - 3 * 86400_000).toISOString() },
      { id: 'rpt-3', title: '低置信度意图复核', summary: '复核 15 条置信度 <0.5 的意图，7 条已修正，5 条归档。', status: 'in_progress', issuesFound: 15, issuesResolved: 12, createdAt: new Date(now - 5 * 86400_000).toISOString() },
      { id: 'rpt-4', title: '意图分类一致性审计', summary: '审计全量意图分类标签，发现 9 条分类不一致。', status: 'archived', issuesFound: 9, issuesResolved: 9, createdAt: new Date(now - 10 * 86400_000).toISOString() },
    ],
    stats: {
      totalIntents: 156,
      activeIntents: 128,
      archivedIntents: 22,
      pendingReview: 6,
      avgConfidence: 0.73,
    },
  };
}

const GOV_KEY = '__kivo_governance_store__';
type GlobalWithGov = typeof globalThis & { [GOV_KEY]?: GovernanceData };

function getGovernanceData(): GovernanceData {
  const scope = globalThis as GlobalWithGov;
  if (!scope[GOV_KEY]) {
    scope[GOV_KEY] = seedGovernanceData();
  }
  return scope[GOV_KEY]!;
}

export async function GET() {
  try {
    const data = getGovernanceData();
    const response: ApiResponse<GovernanceData> = {
      data,
      meta: { total: 1, page: 1, pageSize: 1 },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError((err as Error).message);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, ids } = body as { action: 'archive' | 're-evaluate'; ids: string[] };

    if (!action || !ids?.length) {
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'action and ids are required' } },
        { status: 400 },
      );
    }

    const data = getGovernanceData();

    if (action === 'archive') {
      data.reports = data.reports.map(r =>
        ids.includes(r.id) ? { ...r, status: 'archived' as const } : r,
      );
    }

    return NextResponse.json({ data: { affected: ids.length, action } });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
