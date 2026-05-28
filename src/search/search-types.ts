import type { EntryStatus, KnowledgeEntry, KnowledgeType } from '../types/index.js';
import type { PaginationOptions, TimeRangeFilter } from '../storage/storage-types.js';

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export interface SearchQuery {
  text: string;
  mode?: SearchMode;
}

export interface SearchOptions extends PaginationOptions {
  type?: KnowledgeType | KnowledgeType[];
  domain?: string | string[];
  source?: KnowledgeEntry['source']['type'] | KnowledgeEntry['source']['type'][] | string | string[];
  status?: EntryStatus | EntryStatus[];
  createdAt?: TimeRangeFilter;
  updatedAt?: TimeRangeFilter;
  limit?: number;
  offset?: number;
  minRelevance?: number;
}

export interface SearchResult {
  entry: KnowledgeEntry;
  relevance: number;
  mode: SearchMode;
  matchedTerms?: string[];
  domainGoalMatchedQuestions?: string[];
}

export interface EmbeddingAdapter {
  embed(text: string): Promise<number[]>;
}
