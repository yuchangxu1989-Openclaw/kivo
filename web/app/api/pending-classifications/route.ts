/**
 * GET /api/pending-classifications — KIVO Wave 1 / C1
 *
 * 列出所有等待人工/AI 确认归位的素材（FR-W04 pending 队列）。状态包括
 * pending（A1 刚入库）、in_progress（A2 处理中）、needs_review（A2 完成
 * 但置信度低）、pending_classification（用户拒绝重新排队）。
 *
 * 每条记录附带 material 全字段 + A2 给出的 suggested subject 节点 +
 * 学科域 breadcrumb（从 root 到 leaf），UI 不需要逐条再请求 subjects。
 *
 * 鉴权：依赖 middleware 校验 kivo_session cookie；本路由不再额外鉴权。
 */

import { NextResponse } from 'next/server';

import { serverError } from '@/lib/errors';
import { getPendingClassificationsRepository } from '@/lib/pending-classifications/repository';
import type { PendingClassificationItem } from '@/lib/types/pending-classification';
import type { ApiResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const repo = getPendingClassificationsRepository();
    const items = repo.list();
    const response: ApiResponse<PendingClassificationItem[]> = {
      data: items,
      meta: { total: items.length, page: 1, pageSize: items.length },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
