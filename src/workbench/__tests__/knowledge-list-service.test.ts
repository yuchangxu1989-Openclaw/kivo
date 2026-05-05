import { beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeListService } from '../knowledge-list-service.js';
import type { StorageAdapter, QueryResult, KnowledgeFilter, PaginationOptions } from '../../storage/storage-types.js';
import type { KnowledgeEntry, KnowledgeSource, KnowledgeType, EntryStatus } from '../../types/index.js';
import type { SemanticSearchProvider } from '../knowledge-list-service.js';
import type { KnowledgeListQuery } from '../workbench-types.js';

// ── Test helpers ──────────────────────────────────────────────────────────

let idSeq = 0;

function makeSource(type: KnowledgeSource['type'] = 'document'): KnowledgeSource {
  return { type, reference: `ref://${++idSeq}`, timestamp: new Date('2026-04-20T09:00:00Z') };
}

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `e-${++idSeq}`;
  return {
    id,
    type: 'fact',
    title: `Entry ${id}`,
    content: `Content for ${id}`,
    summary: `Summary for ${id}`,
    source: makeSource(),
    confidence: 0.9,
    status: 'active',
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

/**
 * In-memory StorageAdapter that supports filter matching for testing.
 * Stores entries and filters them on query().
 */
function makeInMemoryStorage(entries: KnowledgeEntry[]): StorageAdapter {
  const store = [...entries];

  function matchFilter(entry: KnowledgeEntry, filter?: KnowledgeFilter): boolean {
    if (!filter) return true;
    if (filter.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      if (!types.includes(entry.type)) return false;
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (!statuses.includes(entry.status)) return false;
    }
    if (filter.source) {
      const sources = Array.isArray(filter.source) ? filter.source : [filter.source];
      if (!sources.includes(entry.source.type as any)) return false;
    }
    if (filter.domain) {
      const domains = Array.isArray(filter.domain) ? filter.domain : [filter.domain];
      if (!entry.domain || !domains.includes(entry.domain)) return false;
    }
    return true;
  }

  return {
    async save(e) { store.push(e); return e; },
    async saveMany(es) { store.push(...es); return es; },
    async get(id) { return store.find((e) => e.id === id) ?? null; },
    async update() { return null; },
    async delete() { return true; },
    async deleteMany() { return 0; },
    async query(filter?: KnowledgeFilter, options?: PaginationOptions): Promise<QueryResult<KnowledgeEntry>> {
      const filtered = store.filter((e) => matchFilter(e, filter));
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? filtered.length;
      return {
        items: filtered.slice(offset, limit > 0 ? offset + limit : undefined),
        total: filtered.length,
        offset,
        limit,
        hasMore: offset + limit < filtered.length,
      };
    },
    async getVersionHistory() { return []; },
  };
}

function makeMockSemanticSearch(results: Array<{ entry: KnowledgeEntry; score: number }>): SemanticSearchProvider {
  return {
    async search(_query: string, limit: number) {
      return results.slice(0, limit);
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════
// FR-W02 AC1: 按类型、状态、来源、知识域筛选 + 分页
// ═════════════════════════════════════════════════════════════════════════

describe('FR-W02 AC1: filter by type, status, source, domain + pagination', () => {
  const entries = [
    makeEntry({ id: 'a1', type: 'fact', status: 'active', source: makeSource('document'), domain: 'infra' }),
    makeEntry({ id: 'a2', type: 'methodology', status: 'active', source: makeSource('conversation'), domain: 'infra' }),
    makeEntry({ id: 'a3', type: 'fact', status: 'pending', source: makeSource('research'), domain: 'ml' }),
    makeEntry({ id: 'a4', type: 'decision', status: 'active', source: makeSource('manual'), domain: 'ml' }),
    makeEntry({ id: 'a5', type: 'fact', status: 'deprecated', source: makeSource('document'), domain: 'infra' }),
  ];

  let service: KnowledgeListService;

  beforeEach(() => {
    idSeq = 100;
    service = new KnowledgeListService({ storage: makeInMemoryStorage(entries) });
  });

  it('returns all entries when no filter applied', async () => {
    const result = await service.list({ page: 1, pageSize: 100 });
    expect(result.items).toHaveLength(5);
    expect(result.totalItems).toBe(5);
  });

  it('filters by single type', async () => {
    const result = await service.list({ filter: { type: 'fact' }, page: 1, pageSize: 100 });
    expect(result.items.every((e) => e.type === 'fact')).toBe(true);
    expect(result.totalItems).toBe(3);
  });

  it('filters by multiple types', async () => {
    const result = await service.list({ filter: { type: ['fact', 'decision'] }, page: 1, pageSize: 100 });
    expect(result.items.every((e) => e.type === 'fact' || e.type === 'decision')).toBe(true);
    expect(result.totalItems).toBe(4);
  });

  it('filters by status', async () => {
    const result = await service.list({ filter: { status: 'active' }, page: 1, pageSize: 100 });
    expect(result.items.every((e) => e.status === 'active')).toBe(true);
    expect(result.totalItems).toBe(3);
  });

  it('filters by source type', async () => {
    const result = await service.list({ filter: { source: 'document' }, page: 1, pageSize: 100 });
    expect(result.items.every((e) => e.source.type === 'document')).toBe(true);
    expect(result.totalItems).toBe(2);
  });

  it('filters by domain', async () => {
    const result = await service.list({ filter: { domain: 'ml' }, page: 1, pageSize: 100 });
    expect(result.items.every((e) => e.domain === 'ml')).toBe(true);
    expect(result.totalItems).toBe(2);
  });

  it('combines multiple filters', async () => {
    const result = await service.list({
      filter: { type: 'fact', status: 'active', domain: 'infra' },
      page: 1,
      pageSize: 100,
    });
    expect(result.totalItems).toBe(1);
    expect(result.items[0].id).toBe('a1');
  });

  it('paginates results correctly', async () => {
    const page1 = await service.list({ page: 1, pageSize: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.page).toBe(1);

    const page2 = await service.list({ page: 2, pageSize: 2 });
    expect(page2.items).toHaveLength(2);
    expect(page2.page).toBe(2);

    const page3 = await service.list({ page: 3, pageSize: 2 });
    expect(page3.items).toHaveLength(1);
    expect(page3.page).toBe(3);

    // No overlap between pages
    const allIds = [...page1.items, ...page2.items, ...page3.items].map((e) => e.id);
    expect(new Set(allIds).size).toBe(5);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// FR-W02 AC2: 分页控件数据（当前页、总页数、总条目数）
// ═════════════════════════════════════════════════════════════════════════

describe('FR-W02 AC2: pagination metadata', () => {
  const entries = Array.from({ length: 25 }, (_, i) =>
    makeEntry({ id: `p-${i}` }),
  );

  let service: KnowledgeListService;

  beforeEach(() => {
    service = new KnowledgeListService({ storage: makeInMemoryStorage(entries) });
  });

  it('returns correct page, pageSize, totalPages, totalItems', async () => {
    const result = await service.list({ page: 1, pageSize: 10 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
    expect(result.totalPages).toBe(3); // ceil(25/10)
    expect(result.totalItems).toBe(25);
  });

  it('totalPages is at least 1 even for empty results', async () => {
    const emptyService = new KnowledgeListService({ storage: makeInMemoryStorage([]) });
    const result = await emptyService.list({ page: 1, pageSize: 10 });
    expect(result.totalPages).toBe(1);
    expect(result.totalItems).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it('last page has correct item count', async () => {
    const result = await service.list({ page: 3, pageSize: 10 });
    expect(result.items).toHaveLength(5); // 25 - 20 = 5
    expect(result.page).toBe(3);
    expect(result.totalPages).toBe(3);
  });

  it('returns empty items for page beyond range', async () => {
    const result = await service.list({ page: 10, pageSize: 10 });
    expect(result.items).toHaveLength(0);
    expect(result.totalItems).toBe(25);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// FR-W02 AC3: 快速搜索（关键词即时过滤）
// ═════════════════════════════════════════════════════════════════════════

describe('FR-W02 AC3: keyword quick-filter', () => {
  const entries = [
    makeEntry({ id: 'k1', title: 'Kubernetes scheduling', content: 'Pod scheduling in K8s', summary: 'K8s pods' }),
    makeEntry({ id: 'k2', title: 'Docker networking', content: 'Bridge networks', summary: 'Docker net' }),
    makeEntry({ id: 'k3', title: 'Helm charts', content: 'Package manager for Kubernetes', summary: 'Helm' }),
    makeEntry({ id: 'k4', title: 'Terraform modules', content: 'IaC with HCL', summary: 'Terraform' }),
  ];

  let service: KnowledgeListService;

  beforeEach(() => {
    service = new KnowledgeListService({ storage: makeInMemoryStorage(entries) });
  });

  it('filters by keyword in title', async () => {
    const result = await service.list({ filter: { keyword: 'kubernetes' }, page: 1, pageSize: 100 });
    expect(result.items.some((e) => e.id === 'k1')).toBe(true);
    expect(result.items.some((e) => e.id === 'k3')).toBe(true); // content contains "Kubernetes"
    expect(result.totalItems).toBe(2);
  });

  it('filters by keyword in content', async () => {
    const result = await service.list({ filter: { keyword: 'bridge' }, page: 1, pageSize: 100 });
    expect(result.totalItems).toBe(1);
    expect(result.items[0].id).toBe('k2');
  });

  it('filters by keyword in summary', async () => {
    const result = await service.list({ filter: { keyword: 'helm' }, page: 1, pageSize: 100 });
    expect(result.totalItems).toBe(1);
    expect(result.items[0].id).toBe('k3');
  });

  it('keyword search is case-insensitive', async () => {
    const result = await service.list({ filter: { keyword: 'DOCKER' }, page: 1, pageSize: 100 });
    expect(result.totalItems).toBe(1);
    expect(result.items[0].id).toBe('k2');
  });

  it('keyword filter applies before pagination', async () => {
    const result = await service.list({ filter: { keyword: 'kubernetes' }, page: 1, pageSize: 1 });
    expect(result.totalItems).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.items).toHaveLength(1);
  });

  it('keyword combined with type filter', async () => {
    // All entries are 'fact' type, so combining with keyword should still work
    const result = await service.list({
      filter: { keyword: 'kubernetes', type: 'fact' },
      page: 1,
      pageSize: 100,
    });
    expect(result.totalItems).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// FR-W02 AC4: 语义搜索（高亮片段 + 相关度评分）
// ═════════════════════════════════════════════════════════════════════════

describe('FR-W02 AC4: semantic search with highlight + score', () => {
  it('returns semantic search results with score and highlightSnippet', async () => {
    const entry = makeEntry({
      id: 's1',
      content: 'The quick brown fox jumps over the lazy dog. Kubernetes scheduling is important for pod placement.',
    });
    const mockSearch = makeMockSemanticSearch([{ entry, score: 0.92 }]);
    const service = new KnowledgeListService({
      storage: makeInMemoryStorage([entry]),
      semanticSearch: mockSearch,
    });

    const results = await service.semanticSearchEntries('kubernetes scheduling', 10);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0.92);
    expect(results[0].entry.id).toBe('s1');
    // highlightSnippet should contain the query match area
    expect(results[0].highlightSnippet).toBeDefined();
    expect(results[0].highlightSnippet!.toLowerCase()).toContain('kubernetes');
  });

  it('returns empty array when no semantic search provider', async () => {
    const service = new KnowledgeListService({
      storage: makeInMemoryStorage([]),
      // no semanticSearch provider
    });
    const results = await service.semanticSearchEntries('anything', 10);
    expect(results).toEqual([]);
  });

  it('respects limit parameter', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ id: `sem-${i}`, content: `Semantic content ${i}` }),
    );
    const mockSearch = makeMockSemanticSearch(
      entries.map((e, i) => ({ entry: e, score: 0.9 - i * 0.1 })),
    );
    const service = new KnowledgeListService({
      storage: makeInMemoryStorage(entries),
      semanticSearch: mockSearch,
    });

    const results = await service.semanticSearchEntries('semantic', 3);
    expect(results).toHaveLength(3);
  });

  it('highlightSnippet is undefined when query not found in content', async () => {
    const entry = makeEntry({ id: 'no-match', content: 'Completely unrelated content about cooking' });
    const mockSearch = makeMockSemanticSearch([{ entry, score: 0.5 }]);
    const service = new KnowledgeListService({
      storage: makeInMemoryStorage([entry]),
      semanticSearch: mockSearch,
    });

    const results = await service.semanticSearchEntries('kubernetes', 10);
    expect(results).toHaveLength(1);
    expect(results[0].highlightSnippet).toBeUndefined();
  });

  it('highlightSnippet truncates long content with ellipsis', async () => {
    const longContent = 'A'.repeat(200) + 'kubernetes scheduling' + 'B'.repeat(200);
    const entry = makeEntry({ id: 'long', content: longContent });
    const mockSearch = makeMockSemanticSearch([{ entry, score: 0.85 }]);
    const service = new KnowledgeListService({
      storage: makeInMemoryStorage([entry]),
      semanticSearch: mockSearch,
    });

    const results = await service.semanticSearchEntries('kubernetes', 10);
    expect(results[0].highlightSnippet).toBeDefined();
    expect(results[0].highlightSnippet!.startsWith('...')).toBe(true);
    expect(results[0].highlightSnippet!.endsWith('...')).toBe(true);
  });
});
