/**
 * GET /api/wiki/spaces/[id]/entries?page=1&pageSize=20&directoryId=&type=&q=
 * POST /api/wiki/spaces/[id]/entries — create a wiki page
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWikiRepository } from '@/lib/wiki-engine';
import { ensureMaterialSpaceExists } from '@/lib/wiki-materials';
import { badRequest, notFound, serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';
import { SearchApi } from '@kivo/wiki/search/search-api';
import { createEmbeddingProvider } from '@kivo/embedding/create-provider';

/**
 * Resolve the `default` literal alias (and missing IDs) to the real default-space UUID.
 * Returns the resolved id, or null when the caller-supplied id is not a wiki_space.
 * Reuses ensureMaterialSpaceExists (lib/wiki-materials.resolveSpaceId) so the web API
 * and the materials pipeline share the same alias semantics.
 */
function resolveSpaceIdOrNull(rawId: string): string | null {
  try {
    return ensureMaterialSpaceExists(rawId);
  } catch {
    return null;
  }
}

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

function collectPageIds(repo: ReturnType<typeof getWikiRepository>, nodeId: string): string[] {
  const ids: string[] = [];
  const visit = (parentId: string) => {
    for (const child of repo.listChildren(parentId)) {
      if (child.type === 'wiki_page') {
        ids.push(child.id);
        visit(child.id);
      } else if (child.type === 'wiki_directory') {
        visit(child.id);
      }
    }
  };
  visit(nodeId);
  return ids;
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

function collectPages(repo: ReturnType<typeof getWikiRepository>, nodeId: string): WikiEntryItem[] {
  const pages: WikiEntryItem[] = [];
  const visit = (parentId: string) => {
    for (const child of repo.listChildren(parentId)) {
      if (child.type === 'wiki_page') {
        // FR-3 (walkthrough P2-4): 过滤掉「暂未提取出合格知识条目」空壳占位。
        if (isEmptyExtractionShell(child.content)) {
          visit(child.id);
          continue;
        }
        const parent = child.parentId ? repo.findById(child.parentId) : null;
        pages.push({
          id: child.id,
          title: child.title,
          summary: child.summary,
          type: child.type,
          knowledgeType: child.metadata?.extra?.knowledgeType as string || 'fact',
          parentId: child.parentId,
          parentTitle: parent?.title ?? null,
          updatedAt: child.updatedAt,
        });
        visit(child.id);
      } else if (child.type === 'wiki_directory') {
        visit(child.id);
      }
    }
  };
  visit(nodeId);
  return pages;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: rawId } = await params;
    const repo = getWikiRepository();
    const id = resolveSpaceIdOrNull(rawId);
    if (!id) return notFound(`Space ${rawId} not found`);
    const space = repo.findById(id);
    if (!space || space.type !== 'wiki_space') return notFound(`Space ${rawId} not found`);

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
    const directoryId = searchParams.get('directoryId') || undefined;
    const type = searchParams.get('type') || undefined;
    const tag = searchParams.get('tag')?.trim() || undefined;
    const query = searchParams.get('q')?.trim();
    if (directoryId && repo.getSpaceIdForNode(directoryId) !== id) {
      return badRequest('directoryId must belong to this space');
    }

    let items: WikiEntryItem[] = [];

    if (query) {
      const searchApi = new SearchApi(repo, createEmbeddingProvider());
      const result = await searchApi.search({
        query,
        limit: 200,
        scope: directoryId ? { directoryId } : { spaceId: id },
      });
      const allowedPageIds = new Set(collectPageIds(repo, directoryId || id));
      items = result.items
        .filter((item) => allowedPageIds.has(item.id) && item.type === 'wiki_page')
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
      items = collectPages(repo, directoryId || id);
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
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: rawId } = await params;
    const repo = getWikiRepository();
    const id = resolveSpaceIdOrNull(rawId);
    if (!id) return notFound(`Space ${rawId} not found`);
    const space = repo.findById(id);
    if (!space || space.type !== 'wiki_space') return notFound(`Space ${rawId} not found`);

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

    const actualParentId = parentId || id;
    const parent = repo.findById(actualParentId);
    if (!parent || (parent.type !== 'wiki_space' && parent.type !== 'wiki_directory')) {
      return badRequest('parentId must be a space or directory');
    }
    if (actualParentId !== id && repo.getSpaceIdForNode(actualParentId) !== id) {
      return badRequest('parentId must belong to this space');
    }

    const page = repo.createPage({
      title: title.trim(),
      content: content.trim(),
      summary: summary?.trim() || '',
      parentId: actualParentId,
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
