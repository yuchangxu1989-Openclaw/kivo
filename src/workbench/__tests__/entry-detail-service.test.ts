import { beforeEach, describe, expect, it } from 'vitest';
import { EntryDetailService } from '../entry-detail-service.js';
import type { AssociationProvider } from '../entry-detail-service.js';
import type { StorageAdapter, QueryResult, KnowledgeFilter, PaginationOptions } from '../../storage/storage-types.js';
import type { KnowledgeEntry, KnowledgeSource } from '../../types/index.js';
import type { AssociationLink } from '../workbench-types.js';

// ── Test helpers ──────────────────────────────────────────────────────────

let idSeq = 0;

function makeSource(): KnowledgeSource {
  return { type: 'document', reference: `doc://${++idSeq}`, timestamp: new Date('2026-04-20T09:00:00Z') };
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
    createdAt: new Date('2026-04-10T09:00:00Z'),
    updatedAt: new Date('2026-04-10T09:00:00Z'),
    version: 1,
    ...overrides,
  };
}

/**
 * In-memory StorageAdapter with version history support.
 * Stores entries keyed by id, and version history as arrays.
 */
function makeStorageWithHistory(
  entries: KnowledgeEntry[],
  versionHistories: Record<string, KnowledgeEntry[]> = {},
): StorageAdapter {
  const store = new Map(entries.map((e) => [e.id, e]));

  return {
    async save(e) { store.set(e.id, e); return e; },
    async saveMany(es) { es.forEach((e) => store.set(e.id, e)); return es; },
    async get(id) { return store.get(id) ?? null; },
    async update() { return null; },
    async delete() { return true; },
    async deleteMany() { return 0; },
    async query(filter?: KnowledgeFilter, options?: PaginationOptions): Promise<QueryResult<KnowledgeEntry>> {
      const items = Array.from(store.values());
      return { items, total: items.length, offset: 0, limit: items.length, hasMore: false };
    },
    async getVersionHistory(id: string): Promise<KnowledgeEntry[]> {
      return versionHistories[id] ?? [];
    },
  };
}

function makeMockAssociations(links: Record<string, AssociationLink[]>): AssociationProvider {
  return {
    async getAssociations(entryId: string) {
      return links[entryId] ?? [];
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════
// FR-W03 AC1: 完整内容、来源引用、版本历史时间线、关联关系
// ═════════════════════════════════════════════════════════════════════════

describe('FR-W03 AC1: entry detail with content, source, versions, associations', () => {
  const mainEntry = makeEntry({
    id: 'detail-1',
    title: 'Kubernetes Pod Scheduling',
    content: 'Detailed content about pod scheduling algorithms and strategies.',
    summary: 'Pod scheduling overview',
    source: { type: 'document', reference: 'doc://k8s-guide.md', timestamp: new Date('2026-04-15T10:00:00Z') },
    version: 3,
    updatedAt: new Date('2026-04-20T10:00:00Z'),
  });

  const versionHistory: KnowledgeEntry[] = [
    makeEntry({
      id: 'detail-1',
      version: 1,
      title: 'K8s Scheduling',
      content: 'Initial content',
      summary: 'Initial',
      updatedAt: new Date('2026-04-10T10:00:00Z'),
    }),
    makeEntry({
      id: 'detail-1',
      version: 2,
      title: 'Kubernetes Scheduling',
      content: 'Updated content about scheduling',
      summary: 'Updated',
      updatedAt: new Date('2026-04-15T10:00:00Z'),
    }),
    makeEntry({
      id: 'detail-1',
      version: 3,
      title: 'Kubernetes Pod Scheduling',
      content: 'Detailed content about pod scheduling algorithms and strategies.',
      summary: 'Pod scheduling overview',
      updatedAt: new Date('2026-04-20T10:00:00Z'),
    }),
  ];

  const associations: AssociationLink[] = [
    { targetId: 'rel-1', targetTitle: 'Node Affinity', relationType: 'supplements' },
    { targetId: 'rel-2', targetTitle: 'Old Scheduling Doc', relationType: 'supersedes' },
  ];

  let service: EntryDetailService;

  beforeEach(() => {
    idSeq = 200;
    service = new EntryDetailService({
      storage: makeStorageWithHistory([mainEntry], { 'detail-1': versionHistory }),
      associations: makeMockAssociations({ 'detail-1': associations }),
    });
  });

  it('returns full entry with all fields', async () => {
    const detail = await service.getDetail('detail-1');
    expect(detail).not.toBeNull();
    expect(detail!.entry.id).toBe('detail-1');
    expect(detail!.entry.title).toBe('Kubernetes Pod Scheduling');
    expect(detail!.entry.content).toContain('pod scheduling algorithms');
    expect(detail!.entry.source.reference).toBe('doc://k8s-guide.md');
    expect(detail!.entry.source.type).toBe('document');
    expect(detail!.entry.version).toBe(3);
  });

  it('returns version history timeline', async () => {
    const detail = await service.getDetail('detail-1');
    expect(detail!.versionHistory).toHaveLength(3);
    expect(detail!.versionHistory[0].version).toBe(1);
    expect(detail!.versionHistory[1].version).toBe(2);
    expect(detail!.versionHistory[2].version).toBe(3);
    // Each version record has updatedAt
    for (const v of detail!.versionHistory) {
      expect(v.updatedAt).toBeInstanceOf(Date);
    }
  });

  it('version 1 has changeSummary "初始创建"', async () => {
    const detail = await service.getDetail('detail-1');
    expect(detail!.versionHistory[0].changeSummary).toBe('初始创建');
  });

  it('returns association links', async () => {
    const detail = await service.getDetail('detail-1');
    expect(detail!.associations).toHaveLength(2);
    expect(detail!.associations[0].targetId).toBe('rel-1');
    expect(detail!.associations[0].relationType).toBe('supplements');
    expect(detail!.associations[1].targetId).toBe('rel-2');
    expect(detail!.associations[1].relationType).toBe('supersedes');
  });

  it('returns null for non-existent entry', async () => {
    const detail = await service.getDetail('non-existent');
    expect(detail).toBeNull();
  });

  it('returns empty associations when no provider configured', async () => {
    const serviceNoAssoc = new EntryDetailService({
      storage: makeStorageWithHistory([mainEntry], { 'detail-1': versionHistory }),
      // no associations provider
    });
    const detail = await serviceNoAssoc.getDetail('detail-1');
    expect(detail).not.toBeNull();
    expect(detail!.associations).toEqual([]);
  });

  it('returns empty version history when storage has none', async () => {
    const entry = makeEntry({ id: 'no-history' });
    const serviceNoHistory = new EntryDetailService({
      storage: makeStorageWithHistory([entry]),
    });
    const detail = await serviceNoHistory.getDetail('no-history');
    expect(detail).not.toBeNull();
    expect(detail!.versionHistory).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// FR-W03 AC2: 关联关系可点击跳转（链接包含 targetId + targetTitle）
// ═════════════════════════════════════════════════════════════════════════

describe('FR-W03 AC2: association links with targetId and targetTitle for navigation', () => {
  it('each association has targetId, targetTitle, and relationType', async () => {
    const entry = makeEntry({ id: 'nav-1' });
    const links: AssociationLink[] = [
      { targetId: 'target-a', targetTitle: 'Related Entry A', relationType: 'supplements' },
      { targetId: 'target-b', targetTitle: 'Conflicting Entry B', relationType: 'conflicts' },
      { targetId: 'target-c', targetTitle: 'Dependency C', relationType: 'depends_on' },
    ];

    const service = new EntryDetailService({
      storage: makeStorageWithHistory([entry]),
      associations: makeMockAssociations({ 'nav-1': links }),
    });

    const detail = await service.getDetail('nav-1');
    expect(detail!.associations).toHaveLength(3);

    for (const assoc of detail!.associations) {
      expect(assoc.targetId).toBeTruthy();
      expect(assoc.targetTitle).toBeTruthy();
      expect(assoc.relationType).toBeTruthy();
    }
  });

  it('supports all relation types: supplements, supersedes, conflicts, depends_on', async () => {
    const entry = makeEntry({ id: 'rel-types' });
    const links: AssociationLink[] = [
      { targetId: 't1', targetTitle: 'T1', relationType: 'supplements' },
      { targetId: 't2', targetTitle: 'T2', relationType: 'supersedes' },
      { targetId: 't3', targetTitle: 'T3', relationType: 'conflicts' },
      { targetId: 't4', targetTitle: 'T4', relationType: 'depends_on' },
    ];

    const service = new EntryDetailService({
      storage: makeStorageWithHistory([entry]),
      associations: makeMockAssociations({ 'rel-types': links }),
    });

    const detail = await service.getDetail('rel-types');
    const types = detail!.associations.map((a) => a.relationType);
    expect(types).toContain('supplements');
    expect(types).toContain('supersedes');
    expect(types).toContain('conflicts');
    expect(types).toContain('depends_on');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// FR-W03 AC3: 版本差异对比
// ═════════════════════════════════════════════════════════════════════════

describe('FR-W03 AC3: version diff comparison', () => {
  const v1 = makeEntry({
    id: 'diff-entry',
    version: 1,
    title: 'Original Title',
    content: 'Original content',
    summary: 'Original summary',
    status: 'active',
    confidence: 0.7,
    updatedAt: new Date('2026-04-10T10:00:00Z'),
  });

  const v2 = makeEntry({
    id: 'diff-entry',
    version: 2,
    title: 'Updated Title',
    content: 'Updated content with more details',
    summary: 'Updated summary',
    status: 'active',
    confidence: 0.9,
    updatedAt: new Date('2026-04-15T10:00:00Z'),
  });

  const v3 = makeEntry({
    id: 'diff-entry',
    version: 3,
    title: 'Updated Title', // same as v2
    content: 'Final content with comprehensive details',
    summary: 'Updated summary', // same as v2
    status: 'active', // same as v2
    confidence: 0.95,
    updatedAt: new Date('2026-04-20T10:00:00Z'),
  });

  let service: EntryDetailService;

  beforeEach(() => {
    service = new EntryDetailService({
      storage: makeStorageWithHistory([v3], { 'diff-entry': [v1, v2, v3] }),
    });
  });

  it('returns diff between two versions with changed fields', async () => {
    const diff = await service.diffVersions('diff-entry', 1, 2);
    expect(diff).not.toBeNull();
    expect(diff!.fromVersion).toBe(1);
    expect(diff!.toVersion).toBe(2);
    expect(diff!.changes.length).toBeGreaterThan(0);

    const titleChange = diff!.changes.find((c) => c.field === 'title');
    expect(titleChange).toBeDefined();
    expect(titleChange!.oldValue).toBe('Original Title');
    expect(titleChange!.newValue).toBe('Updated Title');

    const contentChange = diff!.changes.find((c) => c.field === 'content');
    expect(contentChange).toBeDefined();
    expect(contentChange!.oldValue).toBe('Original content');
    expect(contentChange!.newValue).toBe('Updated content with more details');

    const statusChange = diff!.changes.find((c) => c.field === 'status');
    expect(statusChange).toBeDefined();
    expect(statusChange!.oldValue).toBe('pending');
    expect(statusChange!.newValue).toBe('active');

    const confidenceChange = diff!.changes.find((c) => c.field === 'confidence');
    expect(confidenceChange).toBeDefined();
    expect(confidenceChange!.oldValue).toBe(0.7);
    expect(confidenceChange!.newValue).toBe(0.9);
  });

  it('only includes fields that actually changed', async () => {
    const diff = await service.diffVersions('diff-entry', 2, 3);
    expect(diff).not.toBeNull();

    // title and status and summary are the same between v2 and v3
    const changedFields = diff!.changes.map((c) => c.field);
    expect(changedFields).not.toContain('title');
    expect(changedFields).not.toContain('status');
    expect(changedFields).not.toContain('summary');

    // content and confidence changed
    expect(changedFields).toContain('content');
    expect(changedFields).toContain('confidence');
  });

  it('returns null for non-existent version', async () => {
    const diff = await service.diffVersions('diff-entry', 1, 99);
    expect(diff).toBeNull();
  });

  it('returns null for non-existent entry', async () => {
    const diff = await service.diffVersions('non-existent', 1, 2);
    expect(diff).toBeNull();
  });

  it('returns empty changes when comparing same version', async () => {
    const diff = await service.diffVersions('diff-entry', 2, 2);
    expect(diff).not.toBeNull();
    expect(diff!.changes).toHaveLength(0);
  });

  it('compares fields: title, content, summary, status, confidence', async () => {
    const diff = await service.diffVersions('diff-entry', 1, 2);
    const fields = diff!.changes.map((c) => c.field);
    // All five tracked fields changed between v1 and v2
    expect(fields).toContain('title');
    expect(fields).toContain('content');
    expect(fields).toContain('summary');
    expect(fields).toContain('status');
    expect(fields).toContain('confidence');
  });
});
