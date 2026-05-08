/**
 * KnowledgeRepository — 上层抽象，不感知具体存储引擎。
 * 通过 StorageProvider SPI 委托所有持久化操作。
 */

import type { KnowledgeEntry, EntryStatus, KnowledgeType } from '../types/index.js';
import type { StorageProvider, SemanticQuery, SearchResult, SaveOptions } from './storage-provider.js';

export class KnowledgeRepository {
  constructor(private readonly provider: StorageProvider) {}

  async save(entry: KnowledgeEntry, options?: SaveOptions): Promise<boolean> {
    return this.provider.save(entry, options);
  }

  async findById(id: string): Promise<KnowledgeEntry | null> {
    return this.provider.findById(id);
  }

  async search(query: SemanticQuery): Promise<SearchResult[]> {
    return this.provider.search(query);
  }

  async updateStatus(id: string, status: EntryStatus): Promise<void> {
    return this.provider.updateStatus(id, status);
  }

  async getVersionHistory(id: string): Promise<KnowledgeEntry[]> {
    return this.provider.getVersionHistory(id);
  }

  async findByType(type: KnowledgeType): Promise<KnowledgeEntry[]> {
    return this.provider.findByType(type);
  }

  async fullTextSearch(query: string, limit?: number): Promise<KnowledgeEntry[]> {
    return this.provider.fullTextSearch(query, limit);
  }

  async findAll(): Promise<KnowledgeEntry[]> {
    return this.provider.findAll();
  }

  async delete(id: string): Promise<void> {
    return this.provider.delete(id);
  }

  async count(): Promise<number> {
    return this.provider.count();
  }

  async close(): Promise<void> {
    return this.provider.close();
  }
}
