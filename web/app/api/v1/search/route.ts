/**
 * GET /api/v1/search
 * Semantic search — proxies to KIVO Core Knowledge Query API (FR-G03)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getKivo } from '@/lib/kivo-engine';
import { badRequest, serverError } from '@/lib/errors';
import { findEntriesByIds } from '@/lib/paginated-queries';
import type { ApiResponse } from '@/types';

interface SearchResultItem {
  id: string;
  type: string;
  title: string;
  summary: string;
  content: string;
  status: string;
  score: number;
  highlights: string[];
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');
    const type = searchParams.get('type') || undefined;
    const status = searchParams.get('status') || undefined;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));

    if (!q || q.trim().length === 0) {
      return badRequest('q (search query) is required');
    }

    const kivo = await getKivo();

    // Try semantic search first, fall back to keyword search
    let results: SearchResultItem[] = [];

    try {
      // semanticSearch returns {id, score}[] — batch hydrate to avoid N+1
      const semanticResults = await kivo.semanticSearch(q, pageSize * page);
      const ids = semanticResults.map(r => r.id);
      const scoreMap = new Map(semanticResults.map(r => [r.id, r.score]));
      const entries = findEntriesByIds(ids);
      // Preserve original score ordering
      const entryMap = new Map(entries.map(e => [e.id, e]));
      for (const r of semanticResults) {
        const entry = entryMap.get(r.id);
        if (entry) {
          results.push({
            id: entry.id,
            type: entry.type,
            title: entry.title,
            summary: entry.summary,
            content: entry.content,
            status: entry.status,
            score: scoreMap.get(r.id) ?? r.score,
            highlights: [generateHighlight(entry.content, q)],
          });
        }
      }
    } catch {
      // Semantic search unavailable, fall back to keyword
      const keywordResults = await kivo.query(q);
      results = keywordResults.map(r => ({
        id: r.entry.id,
        type: r.entry.type,
        title: r.entry.title,
        summary: r.entry.summary,
        content: r.entry.content,
        status: r.entry.status,
        score: r.score,
        highlights: [generateHighlight(r.entry.content, q)],
      }));
    }

    // Apply post-filters
    if (type) {
      results = results.filter(r => r.type === type);
    }
    if (status) {
      results = results.filter(r => r.status === status);
    }

    // Paginate
    const total = results.length;
    const offset = (page - 1) * pageSize;
    const items = results.slice(offset, offset + pageSize);

    const response: ApiResponse<SearchResultItem[]> = {
      data: items,
      meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

function generateHighlight(content: string, query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const sentences = content.split(/[.。!！?？\n]+/).filter(Boolean);

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (words.some(w => lower.includes(w))) {
      return sentence.trim().slice(0, 200);
    }
  }

  return content.slice(0, 200);
}
