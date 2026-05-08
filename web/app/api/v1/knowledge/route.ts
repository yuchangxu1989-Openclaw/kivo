/**
 * GET /api/v1/knowledge
 * POST /api/v1/knowledge
 * Knowledge entry list and quick-create endpoint (FR-G02)
 */

import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getKivo, getRepository } from '@/lib/kivo-engine';
import { badRequest, serverError } from '@/lib/errors';
import { findEntriesPaginated } from '@/lib/paginated-queries';
import type { ApiResponse } from '@/types';
import type { KnowledgeEntry, KnowledgeType, EntryStatus } from '@self-evolving-harness/kivo';

const VALID_TYPES: KnowledgeType[] = ['fact', 'methodology', 'decision', 'experience', 'intent', 'meta'];
const VALID_STATUSES: EntryStatus[] = ['active'];

function buildSummary(content: string, fallback?: string) {
  const trimmedFallback = fallback?.trim();
  if (trimmedFallback) return trimmedFallback;

  const compact = content.replace(/\s+/g, ' ').trim();
  if (!compact) return '手动创建的知识条目';
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const type = searchParams.get('type') || undefined;
    const status = searchParams.get('status') || undefined;
    const domain = searchParams.get('domain') || undefined;
    const sort = searchParams.get('sort') || 'updatedAt';
    const source = searchParams.get('source') || undefined;
    const from = searchParams.get('from') || undefined;
    const to = searchParams.get('to') || undefined;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));

    if (type && !VALID_TYPES.includes(type as KnowledgeType)) {
      return badRequest(`Invalid type: ${type}. Valid: ${VALID_TYPES.join(', ')}`);
    }
    if (status && !VALID_STATUSES.includes(status as EntryStatus)) {
      return badRequest(`Invalid status: ${status}. Valid: ${VALID_STATUSES.join(', ')}`);
    }

    await getKivo(); // ensure initialized + seeded

    // SQL-level pagination — no findAll() full table scan
    const result = findEntriesPaginated({
      type: type || undefined,
      status: status || undefined,
      domain: domain || undefined,
      source: source || undefined,
      from: from || undefined,
      to: to || undefined,
      sort,
      page,
      pageSize,
    });

    const response: ApiResponse<KnowledgeEntry[]> = {
      data: result.items,
      meta: { total: result.total, page, pageSize, totalPages: Math.max(1, Math.ceil(result.total / pageSize)) },
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    const type = typeof body?.type === 'string' ? body.type : 'fact';
    const domain = typeof body?.domain === 'string' ? body.domain.trim() : '';
    const summary = typeof body?.summary === 'string' ? body.summary : undefined;

    if (!title) {
      return badRequest('title is required');
    }
    if (!content) {
      return badRequest('content is required');
    }
    if (!VALID_TYPES.includes(type as KnowledgeType)) {
      return badRequest(`Invalid type: ${type}. Valid: ${VALID_TYPES.join(', ')}`);
    }

    const confidence = typeof body?.confidence === 'number' ? Math.max(0, Math.min(1, body.confidence)) : 0.5;

    await getKivo();
    const repo = await getRepository();
    const now = new Date();

    const entry: KnowledgeEntry = {
      id: randomUUID(),
      type: type as KnowledgeType,
      title,
      content,
      summary: buildSummary(content, summary),
      source: {
        type: 'manual',
        reference: 'KIVO Web / Quick Create',
        timestamp: now,
        agent: 'web-user',
      },
      confidence,
      status: 'active',
      tags: [],
      domain: domain || undefined,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    const saved = await repo.save(entry);
    if (!saved) {
      return badRequest('质量门禁拒绝入库，请检查内容是否重复或低价值。');
    }

    const response: ApiResponse<KnowledgeEntry> = {
      data: entry,
    };

    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
