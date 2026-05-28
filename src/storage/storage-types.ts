import type { EntryStatus, KnowledgeEntry, KnowledgeType, KnowledgeSource } from '../types/index.js';

export interface PaginationOptions {
  offset?: number;
  limit?: number;
}

export interface TimeRangeFilter {
  from?: Date;
  to?: Date;
}

export interface KnowledgeFilter {
  type?: KnowledgeType | KnowledgeType[];
  domain?: string | string[];
  source?: KnowledgeSource['type'] | KnowledgeSource['type'][] | string | string[];
  tags?: string[];
  status?: EntryStatus | EntryStatus[];
  confidence?: {
    min?: number;
    max?: number;
  };
  createdAt?: TimeRangeFilter;
  updatedAt?: TimeRangeFilter;
  pagination?: PaginationOptions;
}

export interface QueryResult<T = KnowledgeEntry> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface StorageAdapter {
  save(entry: KnowledgeEntry): Promise<KnowledgeEntry>;
  saveMany(entries: KnowledgeEntry[]): Promise<KnowledgeEntry[]>;
  get(id: string): Promise<KnowledgeEntry | null>;
  update(
    id: string,
    patch: Partial<Omit<KnowledgeEntry, 'id' | 'createdAt' | 'version'>>
  ): Promise<KnowledgeEntry | null>;
  delete(id: string): Promise<boolean>;
  deleteMany(ids: string[]): Promise<number>;
  query(
    filter?: KnowledgeFilter,
    options?: PaginationOptions
  ): Promise<QueryResult<KnowledgeEntry>>;
  getVersionHistory(id: string): Promise<KnowledgeEntry[]>;
}
