/**
 * GET /api/wiki/search?q=xxx&page=1&pageSize=20
 * Uses hybrid search (FTS + vector) through the wiki SearchApi.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWikiRepository } from '@/lib/wiki-engine';
import { badRequest, serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';
import { SearchApi } from '@kivo/wiki/search/search-api';
import { createEmbeddingProvider } from '@kivo/embedding/create-provider';

interface WikiSearchResult {
  id: string;
  title: string;
  summary: string;
  content: string;
  type: string;
  knowledgeType: string;
  parentId: string | null;
  matchReason: string;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim();
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));

    if (!q) return badRequest('q (search query) is required');

    const repo = getWikiRepository();
    const api = new SearchApi(repo, createEmbeddingProvider());
    const result = await api.search({ query: q, limit: page * pageSize * 3 });
    const wikiPages = result.items.filter((item) => item.type === 'wiki_page');
    const paged = wikiPages.slice((page - 1) * pageSize, page * pageSize);

    const response: ApiResponse<WikiSearchResult[]> = {
      data: paged.map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.summary,
        content: item.content,
        type: item.type,
        knowledgeType: item.knowledgeType || 'fact',
        parentId: item.parentId,
        matchReason: item.matchReason,
      })),
      meta: { total: wikiPages.length, page, pageSize, totalPages: Math.max(1, Math.ceil(wikiPages.length / pageSize)) },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
