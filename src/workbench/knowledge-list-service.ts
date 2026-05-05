/**
 * KnowledgeListService — FR-W02 知识列表与搜索数据层
 *
 * AC1: 按类型、状态、来源、知识域筛选 + 分页
 * AC2: 分页控件数据（当前页、总页数、总条目数）
 * AC3: 快速搜索（关键词即时过滤）
 * AC4: 语义搜索结果（高亮片段 + 相关度评分）
 */

import type { StorageAdapter, KnowledgeFilter, PaginationOptions } from '../storage/storage-types.js';
import type { KnowledgeEntry } from '../types/index.js';
import type {
  KnowledgeListQuery,
  KnowledgeListResult,
  SemanticSearchResult,
} from './workbench-types.js';

export interface SemanticSearchProvider {
  search(query: string, limit: number): Promise<Array<{ entry: KnowledgeEntry; score: number }>>;
}

export interface KnowledgeListServiceDeps {
  storage: StorageAdapter;
  semanticSearch?: SemanticSearchProvider;
}

export class KnowledgeListService {
  private storage: StorageAdapter;
  private semanticSearch?: SemanticSearchProvider;

  constructor(deps: KnowledgeListServiceDeps) {
    this.storage = deps.storage;
    this.semanticSearch = deps.semanticSearch;
  }

  /** AC1 + AC2 + AC3: 列表查询、分页、关键词过滤 */
  async list(query: KnowledgeListQuery): Promise<KnowledgeListResult> {
    const filter: KnowledgeFilter = {};
    if (query.filter?.type) filter.type = query.filter.type;
    if (query.filter?.status) filter.status = query.filter.status;
    if (query.filter?.source) filter.source = query.filter.source;
    if (query.filter?.domain) filter.domain = query.filter.domain;

    // Fetch all matching items (keyword filter must run before pagination)
    const result = await this.storage.query(filter);
    let items = result.items;

    // AC3: keyword quick-filter applied before pagination
    if (query.filter?.keyword) {
      const kw = query.filter.keyword.toLowerCase();
      items = items.filter(
        (e) =>
          e.title.toLowerCase().includes(kw) ||
          e.content.toLowerCase().includes(kw) ||
          e.summary.toLowerCase().includes(kw),
      );
    }

    const totalItems = items.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / query.pageSize));
    const offset = (query.page - 1) * query.pageSize;
    const paged = items.slice(offset, offset + query.pageSize);

    return {
      items: paged,
      page: query.page,
      pageSize: query.pageSize,
      totalPages,
      totalItems,
    };
  }

  /** AC4: 语义搜索 */
  async semanticSearchEntries(query: string, limit = 20): Promise<SemanticSearchResult[]> {
    if (!this.semanticSearch) {
      return [];
    }
    const raw = await this.semanticSearch.search(query, limit);
    return raw.map(({ entry, score }) => ({
      entry,
      score,
      highlightSnippet: this.extractSnippet(entry.content, query),
    }));
  }

  private extractSnippet(content: string, query: string): string | undefined {
    const lower = content.toLowerCase();
    const idx = lower.indexOf(query.toLowerCase());
    if (idx < 0) return undefined;
    const start = Math.max(0, idx - 60);
    const end = Math.min(content.length, idx + query.length + 60);
    return (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
  }
}
