/**
 * TermSearch — 精确匹配前置 + 语义检索
 * 查询文本与术语名/别名完全匹配时直接返回，不走语义检索。
 */

import type { KnowledgeEntry } from '../types/index.js';
import type { StorageAdapter, KnowledgeFilter } from '../storage/storage-types.js';
import type { ScoredEntry } from '../injection/relevance-scorer.js';
import type { TermMetadata } from './term-types.js';
import { DICTIONARY_DOMAIN } from './term-types.js';

export interface TermSearchOptions {
  store: StorageAdapter;
}

export class TermSearch {
  private readonly store: StorageAdapter;

  constructor(options: TermSearchOptions) {
    this.store = options.store;
  }

  /**
   * 精确匹配：term 或 alias 完全匹配（大小写不敏感）
   * 命中时直接返回，不走语义检索
   */
  async exactMatch(query: string, scope?: string): Promise<KnowledgeEntry | null> {
    const entries = await this.queryActiveTerms();
    const normalized = query.toLowerCase().trim();

    for (const entry of entries) {
      const meta = entry.metadata as TermMetadata | undefined;
      if (!meta) continue;

      const names = [meta.term, ...meta.aliases].map(n => n.toLowerCase());
      if (!names.includes(normalized)) continue;

      if (scope && !meta.scope.includes(scope)) continue;
      return entry;
    }

    return null;
  }

  /**
   * 按 domain 检索术语，返回带评分的结果
   * 使用简单关键词匹配评分（无 embedding 依赖）
   */
  async searchByDomain(query: string, topK = 10): Promise<ScoredEntry[]> {
    const entries = await this.queryActiveTerms();
    if (entries.length === 0) return [];

    const queryTerms = new Set(
      query.toLowerCase().split(/\s+/).filter(w => w.length > 1),
    );
    if (queryTerms.size === 0) return [];

    const scored: ScoredEntry[] = [];
    for (const entry of entries) {
      const meta = entry.metadata as TermMetadata | undefined;
      if (!meta) continue;

      const entryText = [
        meta.term,
        meta.definition,
        ...meta.aliases,
        ...meta.constraints,
        ...meta.scope,
      ].join(' ').toLowerCase();

      const entryTerms = new Set(entryText.split(/\s+/).filter(w => w.length > 1));
      let matches = 0;
      for (const t of queryTerms) {
        if (entryTerms.has(t)) matches++;
      }

      const score = matches / queryTerms.size;
      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private async queryActiveTerms(): Promise<KnowledgeEntry[]> {
    const filter: KnowledgeFilter = {
      domain: DICTIONARY_DOMAIN,
      type: 'fact',
      status: 'active',
    };
    const result = await this.store.query(filter);
    return result.items;
  }
}
