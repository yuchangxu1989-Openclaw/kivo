/**
 * FR-5 AC-5.1, AC-5.2, AC-5.3 | NFR-2
 * Search API: public interface for hybrid search with scope filtering.
 */

import type { EmbeddingAdapter } from '../types.js';
import type { WikiRepository } from '../db/wiki-repository.js';
import { HybridSearch, type HybridSearchOptions } from './hybrid-search.js';
import { SearchRanker, type RankedResult } from './search-ranker.js';

export interface SearchRequest {
  /** Search query text */
  query: string;
  /** Optional scope filter */
  scope?: { spaceId?: string; directoryId?: string };
  /** Max results (default 20) */
  limit?: number;
  /** Semantic weight override (0-1) */
  semanticWeight?: number;
}

export interface SearchResultItem {
  id: string;
  /** Source entry type, e.g. wiki_page, wiki_directory, fact, decision */
  type: string;
  /** Knowledge classification stored in wiki metadata when available */
  knowledgeType?: string;
  title: string;
  content: string;
  summary: string;
  /** Highlighted snippet around match */
  snippet: string;
  /** Match source explanation */
  matchReason: string;
  score: number;
  spaceId?: string;
  parentId: string | null;
  tags: string[];
  updatedAt: string;
}

export interface SearchResponse {
  items: SearchResultItem[];
  total: number;
  durationMs: number;
  query: string;
  scope?: { spaceId?: string; directoryId?: string };
}

export interface SearchApiOptions {
  /** Default semantic weight */
  semanticWeight?: number;
  /** Max snippet length in chars */
  snippetLength?: number;
}

const DEFAULT_SNIPPET_LENGTH = 200;

export class SearchApi {
  private hybridSearch: HybridSearch;
  private snippetLength: number;

  constructor(
    repository: WikiRepository,
    embedder: EmbeddingAdapter,
    options: SearchApiOptions = {},
  ) {
    const ranker = new SearchRanker(options.semanticWeight);
    this.hybridSearch = new HybridSearch(repository, embedder, ranker);
    this.snippetLength = options.snippetLength ?? DEFAULT_SNIPPET_LENGTH;
  }

  /**
   * Executes a search request and returns formatted results.
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    const searchOptions: HybridSearchOptions = {
      limit: request.limit,
      scope: request.scope,
      semanticWeight: request.semanticWeight,
    };

    const result = await this.hybridSearch.search(request.query, searchOptions);

    const items: SearchResultItem[] = result.results.map((ranked) =>
      this.formatResult(ranked, request.query),
    );

    return {
      items,
      total: items.length,
      durationMs: result.durationMs,
      query: request.query,
      scope: request.scope,
    };
  }

  /**
   * Formats a ranked result into a search result item with snippet and match reason.
   */
  private formatResult(ranked: RankedResult, query: string): SearchResultItem {
    const { entry, score, sources } = ranked;

    // Generate snippet with query context highlighting
    const snippet = this.extractSnippet(entry.content, query);

    // Build match reason (AC-5.3)
    const matchReason = this.buildMatchReason(sources);

    return {
      id: entry.id,
      type: entry.type,
      knowledgeType: typeof entry.metadata?.extra?.knowledgeType === 'string'
        ? entry.metadata.extra.knowledgeType
        : undefined,
      title: entry.title,
      content: entry.content,
      summary: entry.summary,
      snippet,
      matchReason,
      score,
      parentId: entry.parentId,
      tags: entry.tags,
      updatedAt: entry.updatedAt,
    };
  }

  /**
   * Extracts a snippet around the query match in content.
   */
  private extractSnippet(content: string, query: string): string {
    const lowerContent = content.toLowerCase();
    const lowerQuery = query.toLowerCase();

    // Try to find query terms in content
    const terms = lowerQuery.split(/\s+/).filter((t) => t.length > 1);
    let bestPos = -1;

    for (const term of terms) {
      const pos = lowerContent.indexOf(term);
      if (pos !== -1) {
        bestPos = pos;
        break;
      }
    }

    if (bestPos === -1) {
      // No exact match found, return beginning of content
      return content.slice(0, this.snippetLength) + (content.length > this.snippetLength ? '…' : '');
    }

    // Extract snippet centered around match
    const start = Math.max(0, bestPos - Math.floor(this.snippetLength / 4));
    const end = Math.min(content.length, start + this.snippetLength);
    let snippet = content.slice(start, end);

    if (start > 0) snippet = '…' + snippet;
    if (end < content.length) snippet = snippet + '…';

    return snippet;
  }

  /**
   * Builds human-readable match reason from source types.
   * 文案口径与「语义检索」承诺保持一致，不再使用「关键词匹配」字样（FR-C）。
   */
  private buildMatchReason(sources: Array<'fts' | 'vector'>): string {
    if (sources.includes('fts') && sources.includes('vector')) {
      return '语义命中 + 字段召回';
    }
    if (sources.includes('fts')) {
      return '字段召回';
    }
    return '语义命中';
  }
}
