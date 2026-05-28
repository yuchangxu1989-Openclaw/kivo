import type { KnowledgeEntry, KnowledgeFilter, KnowledgeStore, PaginationOptions } from '@self-evolving-harness/kivo';
import { getRepository, persistEntry } from './kivo-engine';

export function reviveKnowledgeEntry(entry: KnowledgeEntry): KnowledgeEntry {
  const sourceTimestamp = entry.source?.timestamp;
  return {
    ...entry,
    source: {
      ...entry.source,
      timestamp: sourceTimestamp ? new Date(sourceTimestamp) : new Date(),
    },
    tags: [...(entry.tags ?? [])],
    similarSentences: entry.similarSentences ? [...entry.similarSentences] : undefined,
    metadata: entry.metadata ? JSON.parse(JSON.stringify(entry.metadata)) : undefined,
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
  };
}

export class RepositoryKnowledgeStore implements KnowledgeStore {
  async save(entry: KnowledgeEntry): Promise<KnowledgeEntry> {
    const normalized = reviveKnowledgeEntry(entry);
    const saved = await persistEntry(normalized);
    if (!saved) {
      throw new Error(`Knowledge entry ${normalized.id} was rejected by repository quality gates.`);
    }
    return normalized;
  }

  async saveMany(entries: KnowledgeEntry[]): Promise<KnowledgeEntry[]> {
    const saved: KnowledgeEntry[] = [];
    for (const entry of entries) {
      saved.push(await this.save(entry));
    }
    return saved;
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    const repo = await getRepository();
    const entry = await repo.findById(id);
    return entry ? reviveKnowledgeEntry(entry) : null;
  }

  async update(
    id: string,
    patch: Partial<Omit<KnowledgeEntry, 'id' | 'createdAt' | 'version'>>,
  ): Promise<KnowledgeEntry | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const next: KnowledgeEntry = reviveKnowledgeEntry({
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: patch.updatedAt ? new Date(patch.updatedAt) : new Date(),
      version: existing.version + 1,
      source: patch.source ?? existing.source,
      tags: patch.tags ? [...patch.tags] : [...existing.tags],
      metadata: patch.metadata ? { ...(existing.metadata ?? {}), ...patch.metadata } : existing.metadata,
    });

    await this.save(next);
    return next;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    const repo = await getRepository();
    await repo.delete(id);
    return true;
  }

  async deleteMany(ids: string[]): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      if (await this.delete(id)) deleted += 1;
    }
    return deleted;
  }

  async query(_filter: KnowledgeFilter = {}, options: PaginationOptions = {}) {
    const repo = await getRepository();
    const all = await repo.findAll();
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : Number.MAX_SAFE_INTEGER;
    const items = all.slice(offset, offset + limit).map(reviveKnowledgeEntry);
    return {
      items,
      total: all.length,
      offset,
      limit,
      hasMore: offset + items.length < all.length,
    };
  }

  async getVersionHistory(id: string): Promise<KnowledgeEntry[]> {
    const repo = await getRepository();
    return (await repo.getVersionHistory(id)).map(reviveKnowledgeEntry);
  }
}
