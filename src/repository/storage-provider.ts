/**
 * StorageProvider — SPI 接口定义
 * 所有存储后端必须实现此接口，上层 Repository 不感知具体存储引擎。
 */

import type { KnowledgeEntry, EntryStatus, KnowledgeType } from '../types/index.js';

export interface SaveOptions {
  skipQualityGate?: boolean;
}

export interface SemanticQuery {
  text: string;
  embedding?: number[];
  filters?: {
    types?: KnowledgeType[];
    status?: EntryStatus[];
    domain?: string;
    timeRange?: { from?: Date; to?: Date };
  };
  topK?: number;
  minScore?: number;
}

export interface SearchResult {
  entry: KnowledgeEntry;
  score: number;
}

export interface StorageProvider {
  save(entry: KnowledgeEntry, options?: SaveOptions): Promise<boolean>;
  findById(id: string): Promise<KnowledgeEntry | null>;
  search(query: SemanticQuery): Promise<SearchResult[]>;
  updateStatus(id: string, status: EntryStatus): Promise<void>;
  getVersionHistory(id: string): Promise<KnowledgeEntry[]>;
  findByType(type: KnowledgeType): Promise<KnowledgeEntry[]>;
  fullTextSearch(query: string, limit?: number): Promise<KnowledgeEntry[]>;
  findAll(): Promise<KnowledgeEntry[]>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
  close(): Promise<void>;
}
