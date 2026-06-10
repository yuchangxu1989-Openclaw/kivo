/**
 * Legacy compatibility route for flat wiki entries.
 * GET /api/wiki/spaces/[id]/entries?page=1&pageSize=20&type=&q=
 * POST /api/wiki/spaces/[id]/entries — create a wiki page without a space parent.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWikiRepository } from '@/lib/wiki-engine';
import { badRequest, serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';
import type { WikiEntryRecord } from '@kivo/wiki';
import { SearchApi } from '@kivo/wiki/search/search-api';
import { createEmbeddingProvider } from '@kivo/embedding/create-provider';

interface WikiEntryItem {
  id: string;
  title: string;
  summary: string;
  type: string;
  knowledgeType: string;
  parentId: string | null;
  parentTitle?: string | null;
  updatedAt: string;
  matchReason?: string;
}

function isEmptyExtractionShell(content: string | null | undefined): boolean {
  if (!content) return true;
  const trimmed = content.trim();
  if (trimmed.length < 30) return true;
  // 「提取知识条目: 0」 是 pipeline-worker 在补零切片时写入的占位内容,
  // 同样该从 wiki 列表隐藏。
  if (/\*\*提取知识条目\*\*\s*[:：]\s*0/.test(trimmed)) return true;
  return false;
}

function mapPage(repo: ReturnType<typeof getWikiRepository>, page: WikiEntryRecord): WikiEntryItem {
  const parent = page.parentId ? repo.findById(page.parentId) : null;
  return {
    id: page.id,
    title: page.title,
    summary: page.summary,
    type: page.type,
    knowledgeType: page.metadata?.extra?.knowledgeType as string || 'fact',
    parentId: page.parentId,
    parentTitle: parent?.title ?? null,
    updatedAt: page.updatedAt,
  };
}

function collectPages(repo: ReturnType<typeof getWikiRepository>): WikiEntryItem[] {
  return repo
    .listAllPages()
    .filter((page) => !isEmptyExtractionShell(page.content))
    .map((page) => mapPage(repo, page));
}

export async function GET(
  request: NextRequest,
  context?: { params: Promise<{ id: string }> },
) {
  try {
    await context?.params;
    const repo = getWikiRepository();

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
    const directoryId = searchParams.get('directoryId') || undefined;
    const type = searchParams.get('type') || undefined;
    const tag = searchParams.get('tag')?.trim() || undefined;
    const query = searchParams.get('q')?.trim();
    void directoryId;

    let items: WikiEntryItem[] = [];

    if (query) {
      const searchApi = new SearchApi(repo, createEmbeddingProvider());
      const result = await searchApi.search({
        query,
        limit: 200,
      });
      items = result.items
        .filter((item) => item.type === 'wiki_page')
        .map((item) => ({
          id: item.id,
          title: item.title,
          summary: item.summary,
          type: item.type,
          knowledgeType: item.knowledgeType || 'fact',
          parentId: item.parentId,
          parentTitle: item.parentId ? repo.findById(item.parentId)?.title ?? null : null,
          updatedAt: item.updatedAt,
          matchReason: item.matchReason,
        }))
        // FR-3 (walkthrough P2-4): 同样过滤掉空壳 wiki_page。
        .filter((item) => {
          const detail = repo.findById(item.id);
          return !isEmptyExtractionShell(detail?.content);
        });
    } else {
      items = collectPages(repo);
    }

    if (type) {
      items = items.filter((item) => item.type === type);
    }

    if (tag) {
      items = items.filter((item) => {
        const entry = repo.findById(item.id);
        return entry?.tags?.includes(tag);
      });
    }

    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const paged = items.slice((page - 1) * pageSize, page * pageSize);

    const response: ApiResponse<WikiEntryItem[]> = {
      data: paged,
      meta: { total, page, pageSize, totalPages },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(
  request: NextRequest,
  context?: { params: Promise<{ id: string }> },
) {
  try {
    await context?.params;
    const repo = getWikiRepository();

    const body = await request.json();
    const { title, content, summary, type, tags, parentId } = body as {
      title?: string;
      content?: string;
      summary?: string;
      type?: string;
      tags?: string[];
      parentId?: string;
    };

    if (!title?.trim()) return badRequest('title is required');
    if (!content?.trim()) return badRequest('content is required');

    void parentId;

    const page = repo.createPage({
      title: title.trim(),
      content: content.trim(),
      summary: summary?.trim() || '',
      parentId: null,
      tags: Array.isArray(tags) ? tags : [],
      metadata: {
        extra: {
          knowledgeType: type || 'fact',
          graphNodeHref: `/graph?focus=${title.trim()}`,
        },
      },
    });

    return NextResponse.json({ data: { id: page.id, title: page.title } }, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
