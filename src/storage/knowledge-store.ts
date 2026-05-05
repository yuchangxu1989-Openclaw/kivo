import type { KnowledgeEntry } from '../types/index.js';
import type {
  KnowledgeFilter,
  PaginationOptions,
  QueryResult,
  StorageAdapter,
  TimeRangeFilter,
} from './storage-types.js';

export interface KnowledgeStore extends StorageAdapter {}

export class MemoryKnowledgeStore implements KnowledgeStore {
  private readonly entries = new Map<string, KnowledgeEntry>();
  private readonly versionHistory = new Map<string, KnowledgeEntry[]>();

  async save(entry: KnowledgeEntry): Promise<KnowledgeEntry> {
    const normalized = cloneEntry(entry);
    this.entries.set(normalized.id, normalized);
    this.appendHistory(normalized.id, normalized);
    return cloneEntry(normalized);
  }

  async saveMany(entries: KnowledgeEntry[]): Promise<KnowledgeEntry[]> {
    const saved: KnowledgeEntry[] = [];
    for (const entry of entries) {
      saved.push(await this.save(entry));
    }
    return saved;
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    const entry = this.entries.get(id);
    return entry ? cloneEntry(entry) : null;
  }

  async update(
    id: string,
    patch: Partial<Omit<KnowledgeEntry, 'id' | 'createdAt' | 'version'>>
  ): Promise<KnowledgeEntry | null> {
    const existing = this.entries.get(id);
    if (!existing) {
      return null;
    }

    const updatedAt = patch.updatedAt ?? new Date();
    const next: KnowledgeEntry = {
      ...existing,
      ...clonePatch(patch),
      id: existing.id,
      createdAt: new Date(existing.createdAt),
      updatedAt: new Date(updatedAt),
      version: existing.version + 1,
      source: patch.source ? cloneSource(patch.source) : cloneSource(existing.source),
      tags: patch.tags ? [...patch.tags] : [...existing.tags],
      metadata: mergeMetadata(existing.metadata, patch.metadata),
    };

    this.entries.set(id, next);
    this.appendHistory(id, next);
    return cloneEntry(next);
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async deleteMany(ids: string[]): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      if (this.entries.delete(id)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  async query(
    filter: KnowledgeFilter = {},
    options: PaginationOptions = {}
  ): Promise<QueryResult<KnowledgeEntry>> {
    const pagination = mergePagination(filter.pagination, options);

    const filtered = Array.from(this.entries.values())
      .filter((entry) => matchesFilter(entry, filter))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    const offset = normalizeOffset(pagination.offset);
    const limit = normalizeLimit(pagination.limit);
    const items = filtered
      .slice(offset, offset + limit)
      .map((entry) => cloneEntry(entry));

    return {
      items,
      total: filtered.length,
      offset,
      limit,
      hasMore: offset + items.length < filtered.length,
    };
  }

  async getVersionHistory(id: string): Promise<KnowledgeEntry[]> {
    const history = this.versionHistory.get(id) ?? [];
    return history.map((entry) => cloneEntry(entry));
  }

  private appendHistory(id: string, entry: KnowledgeEntry): void {
    const history = this.versionHistory.get(id) ?? [];
    history.push(cloneEntry(entry));
    history.sort((a, b) => a.version - b.version);
    this.versionHistory.set(id, history);
  }
}

function matchesFilter(entry: KnowledgeEntry, filter: KnowledgeFilter): boolean {
  const types = normalizeArray(filter.type);
  if (types && !types.includes(entry.type)) {
    return false;
  }

  const domains = normalizeArray(filter.domain);
  if (domains) {
    if (!entry.domain || !domains.includes(entry.domain)) {
      return false;
    }
  }

  const sources = normalizeArray(filter.source);
  if (sources) {
    const referenceMatched = sources.includes(entry.source.reference);
    const typeMatched = sources.includes(entry.source.type);
    if (!referenceMatched && !typeMatched) {
      return false;
    }
  }

  const statuses = normalizeArray(filter.status);
  if (statuses && !statuses.includes(entry.status)) {
    return false;
  }

  if (filter.tags && filter.tags.length > 0) {
    const tagSet = new Set(entry.tags);
    if (!filter.tags.every((tag) => tagSet.has(tag))) {
      return false;
    }
  }

  if (filter.confidence?.min !== undefined && entry.confidence < filter.confidence.min) {
    return false;
  }

  if (filter.confidence?.max !== undefined && entry.confidence > filter.confidence.max) {
    return false;
  }

  if (!matchesTimeRange(entry.createdAt, filter.createdAt)) {
    return false;
  }

  if (!matchesTimeRange(entry.updatedAt, filter.updatedAt)) {
    return false;
  }

  return true;
}

function normalizeArray<T>(value?: T | T[]): T[] | null {
  if (value === undefined) {
    return null;
  }
  return Array.isArray(value) ? value : [value];
}

function mergePagination(
  filterPagination: PaginationOptions | undefined,
  directOptions: PaginationOptions
): PaginationOptions {
  return {
    offset: directOptions.offset ?? filterPagination?.offset,
    limit: directOptions.limit ?? filterPagination?.limit,
  };
}

function normalizeOffset(offset?: number): number {
  if (offset === undefined || offset < 0) {
    return 0;
  }
  return Math.floor(offset);
}

function normalizeLimit(limit?: number): number {
  if (limit === undefined || limit <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.floor(limit);
}

function matchesTimeRange(value: Date, range?: TimeRangeFilter): boolean {
  if (!range) {
    return true;
  }

  if (range.from && value.getTime() < range.from.getTime()) {
    return false;
  }

  if (range.to && value.getTime() > range.to.getTime()) {
    return false;
  }

  return true;
}

function cloneEntry(entry: KnowledgeEntry): KnowledgeEntry {
  return {
    ...entry,
    source: cloneSource(entry.source),
    tags: [...entry.tags],
    similarSentences: entry.similarSentences ? [...entry.similarSentences] : undefined,
    metadata: cloneMetadata(entry.metadata),
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
  };
}

function clonePatch(
  patch: Partial<Omit<KnowledgeEntry, 'id' | 'createdAt' | 'version'>>
): Partial<Omit<KnowledgeEntry, 'id' | 'createdAt' | 'version'>> {
  return {
    ...patch,
    source: patch.source ? cloneSource(patch.source) : undefined,
    tags: patch.tags ? [...patch.tags] : undefined,
    metadata: cloneMetadata(patch.metadata),
    updatedAt: patch.updatedAt ? new Date(patch.updatedAt) : undefined,
  };
}

function cloneSource(source: KnowledgeEntry['source']): KnowledgeEntry['source'] {
  return {
    ...source,
    timestamp: new Date(source.timestamp),
  };
}

function cloneMetadata(metadata: KnowledgeEntry['metadata']): KnowledgeEntry['metadata'] {
  if (!metadata) {
    return undefined;
  }

  return {
    ...metadata,
    deprecatedAt: metadata.deprecatedAt ? new Date(metadata.deprecatedAt) : undefined,
    archivedAt: metadata.archivedAt ? new Date(metadata.archivedAt) : undefined,
    domainData: metadata.domainData ? { ...metadata.domainData } : undefined,
    embedding: metadata.embedding
      ? {
          ...metadata.embedding,
          updatedAt: metadata.embedding.updatedAt ? new Date(metadata.embedding.updatedAt) : undefined,
        }
      : undefined,
  };
}

function mergeMetadata(
  existing: KnowledgeEntry['metadata'],
  patch: KnowledgeEntry['metadata']
): KnowledgeEntry['metadata'] {
  if (!existing && !patch) {
    return undefined;
  }

  return cloneMetadata({
    ...(existing ?? {}),
    ...(patch ?? {}),
    domainData:
      existing?.domainData || patch?.domainData
        ? {
            ...(existing?.domainData ?? {}),
            ...(patch?.domainData ?? {}),
          }
        : undefined,
    embedding:
      existing?.embedding || patch?.embedding
        ? {
            status: 'pending_rebuild' as const,
            ...(existing?.embedding ?? {}),
            ...(patch?.embedding ?? {}),
          }
        : undefined,
  });
}
