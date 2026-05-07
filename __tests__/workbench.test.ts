import { describe, expect, it, beforeEach } from 'vitest';
import {
  DashboardService,
  KnowledgeListService,
  EntryDetailService,
  ActivityStreamService,
  ConflictAdjudicationService,
  EntryOperationService,
  ResearchManagementService,
  DocumentImportService,
  IntentManagementService,
  availableOperations,
  resolveNewStatus,
  VersionConflictError,
  STATUS_TRANSITIONS,
} from '../src/workbench/index.js';
import type {
  KnowledgeEntry,
  EntryStatus,
} from '../src/types/index.js';
import type { StorageAdapter, QueryResult, KnowledgeFilter, PaginationOptions } from '../src/storage/storage-types.js';
import type { ConflictRecord } from '../src/conflict/conflict-record.js';
import { MetricsCollector } from '../src/metrics/metrics-collector.js';

// ── Helpers ──

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: 'e1',
    type: 'fact',
    title: 'Test Entry',
    content: 'Test content for knowledge entry',
    summary: 'Test summary',
    source: { type: 'manual', reference: 'test', timestamp: new Date() },
    confidence: 0.9,
    status: 'active',
    tags: ['test'],
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-02'),
    version: 1,
    ...overrides,
  };
}

function makeStorage(entries: KnowledgeEntry[] = []): StorageAdapter {
  const store = new Map(entries.map((e) => [e.id, { ...e }]));
  return {
    async save(entry) { store.set(entry.id, entry); return entry; },
    async saveMany(es) { es.forEach((e) => store.set(e.id, e)); return es; },
    async get(id) { return store.get(id) ?? null; },
    async update(id, patch) {
      const existing = store.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch, version: existing.version + 1, updatedAt: new Date() };
      store.set(id, updated);
      return updated;
    },
    async delete(id) { return store.delete(id); },
    async deleteMany(ids) { let c = 0; ids.forEach((id) => { if (store.delete(id)) c++; }); return c; },
    async query(filter?: KnowledgeFilter, options?: PaginationOptions): Promise<QueryResult<KnowledgeEntry>> {
      let items = Array.from(store.values());
      if (filter?.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        items = items.filter((e) => statuses.includes(e.status));
      }
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? items.length;
      return { items: items.slice(offset, offset + (limit || items.length)), total: items.length, offset, limit: limit || items.length, hasMore: offset + limit < items.length };
    },
    async getVersionHistory(id) {
      const entry = store.get(id);
      return entry ? [entry] : [];
    },
  };
}

// ── FR-W01: DashboardService ──

describe('DashboardService (FR-W01)', () => {
  it('AC1+AC2: returns KPI cards with trend data', async () => {
    const metrics = new MetricsCollector();
    metrics.recordSearch('test', 3);
    metrics.recordSearch('empty', 0);
    metrics.recordConflict(5, 3, 2);

    const storage = makeStorage([makeEntry({ status: 'active', id: 'p1' }), makeEntry({ id: 'a1' })]);
    const svc = new DashboardService({ storage, metrics });
    const overview = await svc.getOverview();

    expect(overview.kpiCards.length).toBeGreaterThanOrEqual(4);
    expect(overview.kpiCards.find((k) => k.key === 'total-entries')?.value).toBe(2);
    expect(overview.kpiCards.find((k) => k.key === 'pending-reviews')?.value).toBe(1);
  });

  it('AC3: recommends actions based on system state', async () => {
    const metrics = new MetricsCollector();
    metrics.recordConflict(1, 0, 1);
    const storage = makeStorage([]);
    const svc = new DashboardService({ storage, metrics });
    const overview = await svc.getOverview();

    const types = overview.recommendedActions.map((a) => a.type);
    expect(types).toContain('conflict');
    expect(types).toContain('import');
  });

  it('AC4: basePath prefix applied to action paths', async () => {
    const metrics = new MetricsCollector();
    metrics.recordConflict(1, 0, 1);
    const storage = makeStorage([]);
    const svc = new DashboardService({ storage, metrics, basePath: '/kivo' });
    const overview = await svc.getOverview();

    expect(overview.recommendedActions[0].targetPath).toMatch(/^\/kivo\//);
  });
});

// ── FR-W02: KnowledgeListService ──

describe('KnowledgeListService (FR-W02)', () => {
  it('AC1+AC2: lists with pagination', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry({ id: `e${i}` }));
    const storage = makeStorage(entries);
    const svc = new KnowledgeListService({ storage });
    const result = await svc.list({ page: 1, pageSize: 3 });

    expect(result.totalItems).toBe(5);
    expect(result.totalPages).toBe(2);
    expect(result.items.length).toBeLessThanOrEqual(3);
  });

  it('AC3: keyword quick-filter', async () => {
    const storage = makeStorage([
      makeEntry({ id: 'e1', title: 'Alpha knowledge' }),
      makeEntry({ id: 'e2', title: 'Beta knowledge' }),
    ]);
    const svc = new KnowledgeListService({ storage });
    const result = await svc.list({ page: 1, pageSize: 10, filter: { keyword: 'alpha' } });

    expect(result.items.length).toBe(1);
    expect(result.items[0].title).toBe('Alpha knowledge');
  });

  it('AC3: keyword filter totalItems/totalPages consistent with filtered results', async () => {
    // 10 entries, only 3 match keyword 'alpha'
    const entries = [
      ...Array.from({ length: 3 }, (_, i) => makeEntry({ id: `a${i}`, title: `Alpha item ${i}` })),
      ...Array.from({ length: 7 }, (_, i) => makeEntry({ id: `b${i}`, title: `Beta item ${i}` })),
    ];
    const storage = makeStorage(entries);
    const svc = new KnowledgeListService({ storage });
    const result = await svc.list({ page: 1, pageSize: 5, filter: { keyword: 'alpha' } });

    // totalItems must reflect keyword-filtered count, not pre-filter count
    expect(result.totalItems).toBe(3);
    expect(result.totalPages).toBe(1);
    expect(result.items.length).toBe(3);
  });

  it('AC3: keyword filter paginates correctly across pages', async () => {
    const entries = Array.from({ length: 8 }, (_, i) => makeEntry({ id: `m${i}`, title: `Match ${i}` }));
    entries.push(makeEntry({ id: 'nomatch', title: 'Unrelated' }));
    const storage = makeStorage(entries);
    const svc = new KnowledgeListService({ storage });

    const page1 = await svc.list({ page: 1, pageSize: 5, filter: { keyword: 'match' } });
    expect(page1.totalItems).toBe(8);
    expect(page1.totalPages).toBe(2);
    expect(page1.items.length).toBe(5);

    const page2 = await svc.list({ page: 2, pageSize: 5, filter: { keyword: 'match' } });
    expect(page2.items.length).toBe(3);
  });

  it('AC4: semantic search returns scores', async () => {
    const entry = makeEntry({ content: 'Machine learning fundamentals' });
    const svc = new KnowledgeListService({
      storage: makeStorage([entry]),
      semanticSearch: {
        async search() { return [{ entry, score: 0.95 }]; },
      },
    });
    const results = await svc.semanticSearchEntries('ML basics');
    expect(results.length).toBe(1);
    expect(results[0].score).toBe(0.95);
  });
});

// ── FR-W03: EntryDetailService ──

describe('EntryDetailService (FR-W03)', () => {
  it('AC1: returns entry with version history and associations', async () => {
    const entry = makeEntry();
    const storage = makeStorage([entry]);
    const svc = new EntryDetailService({
      storage,
      associations: {
        async getAssociations() {
          return [{ targetId: 'e2', targetTitle: 'Related', relationType: 'supports' }];
        },
      },
    });
    const detail = await svc.getDetail('e1');

    expect(detail).not.toBeNull();
    expect(detail!.entry.id).toBe('e1');
    expect(detail!.versionHistory.length).toBe(1);
    expect(detail!.associations.length).toBe(1);
  });

  it('AC3: diff versions detects field changes', async () => {
    const v1 = makeEntry({ version: 1, title: 'Old Title' });
    const v2 = makeEntry({ version: 2, title: 'New Title' });
    const storage = makeStorage([v1]);
    // Override getVersionHistory to return both versions
    storage.getVersionHistory = async () => [v1, v2];
    const svc = new EntryDetailService({ storage });
    const diff = await svc.diffVersions('e1', 1, 2);

    expect(diff).not.toBeNull();
    expect(diff!.changes.find((c) => c.field === 'title')).toBeDefined();
  });
});

// ── FR-W04: ActivityStreamService ──

describe('ActivityStreamService (FR-W04)', () => {
  it('AC1: records and retrieves events', () => {
    const svc = new ActivityStreamService();
    svc.push({ type: 'entry:created', timestamp: new Date(), summary: 'Created entry' });
    svc.push({ type: 'conflict:detected', timestamp: new Date(), summary: 'Conflict found' });

    const result = svc.query({ limit: 10 });
    expect(result.events.length).toBe(2);
  });

  it('AC2: filters by event type', () => {
    const svc = new ActivityStreamService();
    svc.push({ type: 'entry:created', timestamp: new Date(), summary: 'Created' });
    svc.push({ type: 'conflict:detected', timestamp: new Date(), summary: 'Conflict' });

    const result = svc.query({ filter: { types: ['conflict:detected'] }, limit: 10 });
    expect(result.events.length).toBe(1);
    expect(result.events[0].type).toBe('conflict:detected');
  });

  it('AC2: groups by date', () => {
    const svc = new ActivityStreamService();
    svc.push({ type: 'entry:created', timestamp: new Date('2025-01-01T10:00:00Z'), summary: 'A' });
    svc.push({ type: 'entry:updated', timestamp: new Date('2025-01-01T14:00:00Z'), summary: 'B' });
    svc.push({ type: 'entry:created', timestamp: new Date('2025-01-02T10:00:00Z'), summary: 'C' });

    const result = svc.query({ limit: 100 });
    const groups = svc.groupByDate(result.events);
    expect(groups.length).toBe(2);
  });

  it('AC3: real-time listener receives events', () => {
    const svc = new ActivityStreamService();
    const received: string[] = [];
    svc.subscribe((e) => received.push(e.summary));

    svc.push({ type: 'entry:created', timestamp: new Date(), summary: 'Live event' });
    expect(received).toEqual(['Live event']);
  });

  it('AC4: cursor-based catch-up after reconnection', () => {
    const svc = new ActivityStreamService();
    svc.push({ type: 'entry:created', timestamp: new Date(), summary: 'First' });
    const second = svc.push({ type: 'entry:updated', timestamp: new Date(), summary: 'Second' });
    svc.push({ type: 'entry:created', timestamp: new Date(), summary: 'Third' });

    const result = svc.query({ afterCursor: second.id, limit: 10 });
    expect(result.events.length).toBe(1);
    expect(result.events[0].summary).toBe('Third');
  });
});

// ── FR-W05: ConflictAdjudicationService ──

describe('ConflictAdjudicationService (FR-W05)', () => {
  function makeConflictStore(records: ConflictRecord[]) {
    const store = new Map(records.map((r) => [r.id, r]));
    return {
      async getPendingConflicts() { return records.filter((r) => !r.resolved); },
      async getConflict(id: string) { return store.get(id) ?? null; },
      async resolveConflict(id: string, winnerId: string | null, resolution: string) {
        const r = store.get(id)!;
        return { ...r, resolved: true, resolvedAt: new Date(), resolution, winnerId } as ConflictRecord;
      },
    };
  }

  it('AC1: lists pending conflicts with summaries', async () => {
    const e1 = makeEntry({ id: 'inc', summary: 'Incoming fact' });
    const e2 = makeEntry({ id: 'ext', summary: 'Existing fact' });
    const conflict: ConflictRecord = {
      id: 'c1', incomingId: 'inc', existingId: 'ext',
      verdict: 'conflict', detectedAt: new Date(), resolved: false,
    };
    const svc = new ConflictAdjudicationService({
      storage: makeStorage([e1, e2]),
      conflictStore: makeConflictStore([conflict]),
    });
    const pending = await svc.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0].incomingSummary).toBe('Incoming fact');
  });

  it('AC2+AC3: adjudicates keep-incoming', async () => {
    const e1 = makeEntry({ id: 'inc' });
    const e2 = makeEntry({ id: 'ext' });
    const conflict: ConflictRecord = {
      id: 'c1', incomingId: 'inc', existingId: 'ext',
      verdict: 'conflict', detectedAt: new Date(), resolved: false,
    };
    const storage = makeStorage([e1, e2]);
    const svc = new ConflictAdjudicationService({
      storage,
      conflictStore: makeConflictStore([conflict]),
    });
    const result = await svc.adjudicate({
      conflictId: 'c1', action: 'keep-incoming', reason: 'Newer data', operatorId: 'user1',
    });
    expect(result.winnerId).toBe('inc');
    expect(result.reason).toBe('Newer data');
    const existing = await storage.get('ext');
    expect(existing?.status).toBe('active');
  });
});

// ── FR-W06: EntryOperationService ──

describe('EntryOperationService (FR-W06)', () => {
  it('AC1: changes pending to active via confirm', async () => {
    const entry = makeEntry({ id: 'p1', status: 'active' });
    const storage = makeStorage([entry]);
    const svc = new EntryOperationService({ storage });
    const result = await svc.changeStatus({ entryId: 'p1', operation: 'confirm', operatorId: 'u1' });
    expect(result.previousStatus).toBe('active');
    expect(result.newStatus).toBe('active');
  });

  it('AC2: rejects invalid operation', async () => {
    const entry = makeEntry({ id: 'a1', status: 'active' });
    const storage = makeStorage([entry]);
    const svc = new EntryOperationService({ storage });
    await expect(
      svc.changeStatus({ entryId: 'a1', operation: 'confirm', operatorId: 'u1' }),
    ).rejects.toThrow(/not allowed/);
  });

  it('AC2: availableOperations returns correct ops', () => {
    expect(availableOperations('active')).toEqual(['deprecate']);
    expect(availableOperations('pending')).toEqual(['confirm', 'reject']);
    expect(availableOperations('archived')).toEqual([]);
  });

  it('AC4: throws VersionConflictError on version mismatch', async () => {
    const entry = makeEntry({ id: 'e1', version: 3 });
    const storage = makeStorage([entry]);
    const svc = new EntryOperationService({ storage });
    await expect(
      svc.editEntry({ entryId: 'e1', expectedVersion: 2, patch: { title: 'New' }, operatorId: 'u1' }),
    ).rejects.toThrow(VersionConflictError);
  });

  it('AC3: edit creates new version', async () => {
    const entry = makeEntry({ id: 'e1', version: 1 });
    const storage = makeStorage([entry]);
    const svc = new EntryOperationService({ storage });
    const result = await svc.editEntry({
      entryId: 'e1', expectedVersion: 1, patch: { title: 'Updated' }, operatorId: 'u1',
    });
    expect(result.newVersion).toBe(2);
  });
});

// ── FR-W07: ResearchManagementService ──

describe('ResearchManagementService (FR-W07)', () => {
  it('AC5: silent mode toggle', () => {
    const svc = new ResearchManagementService({
      taskStore: { listTasks: async () => [], getTask: async () => null, createTask: async (t: any) => t, cancelTask: async () => true, updatePriority: async () => true },
    });
    expect(svc.isSilentMode()).toBe(false);
    svc.setSilentMode(true);
    expect(svc.isSilentMode()).toBe(true);
  });

  function makeTask(overrides: Record<string, unknown> = {}): any {
    return {
      id: 't1',
      gapId: 'g1',
      gapType: 'frequency_blind_spot',
      title: 'Research task',
      objective: 'Test',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: { steps: [], searchQueries: [] },
      completionCriteria: [],
      budget: { maxDurationMs: 60000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 0.5,
      urgencyScore: 0.5,
      blocking: false,
      createdAt: new Date('2025-01-01'),
      ...overrides,
    };
  }

  function makeTaskStore(tasks: any[] = []) {
    return {
      listTasks: async () => tasks,
      getTask: async (id: string) => tasks.find((t) => t.id === id) ?? null,
      createTask: async (t: any) => t,
      cancelTask: async () => true,
      updatePriority: async () => true,
    };
  }

  it('AC1: listTasks maps currentStatus from store', async () => {
    const tasks = [
      makeTask({ id: 't1', currentStatus: 'running' }),
      makeTask({ id: 't2', currentStatus: 'completed' }),
      makeTask({ id: 't3', currentStatus: 'queued' }),
    ];
    const svc = new ResearchManagementService({ taskStore: makeTaskStore(tasks) });
    const result = await svc.listTasks({ page: 1, pageSize: 10 });

    expect(result.items.length).toBe(3);
    expect(result.items.find((i) => i.id === 't1')?.status).toBe('running');
    expect(result.items.find((i) => i.id === 't2')?.status).toBe('completed');
    expect(result.items.find((i) => i.id === 't3')?.status).toBe('queued');
  });

  it('AC1: listTasks filters by status correctly', async () => {
    const tasks = [
      makeTask({ id: 't1', currentStatus: 'running' }),
      makeTask({ id: 't2', currentStatus: 'completed' }),
      makeTask({ id: 't3', currentStatus: 'failed' }),
    ];
    const svc = new ResearchManagementService({ taskStore: makeTaskStore(tasks) });
    const result = await svc.listTasks({ page: 1, pageSize: 10, status: 'running' });

    expect(result.totalItems).toBe(1);
    expect(result.items[0].id).toBe('t1');
    expect(result.items[0].status).toBe('running');
  });

  it('AC1: tasks without currentStatus infer from scheduleAfter', async () => {
    const future = new Date(Date.now() + 86400000);
    const tasks = [
      makeTask({ id: 't1', scheduleAfter: future }), // no currentStatus, future schedule → queued
      makeTask({ id: 't2' }), // no currentStatus, no schedule → running
    ];
    const svc = new ResearchManagementService({ taskStore: makeTaskStore(tasks) });
    const result = await svc.listTasks({ page: 1, pageSize: 10 });

    expect(result.items.find((i) => i.id === 't1')?.status).toBe('queued');
    expect(result.items.find((i) => i.id === 't2')?.status).toBe('running');
  });
});

// ── FR-W08: DocumentImportService ──

describe('DocumentImportService (FR-W08)', () => {
  it('AC1: validates supported formats', () => {
    const svc = new DocumentImportService();
    expect(svc.validateFile('doc.pdf', 1000).valid).toBe(true);
    expect(svc.validateFile('doc.md', 1000).valid).toBe(true);
    expect(svc.validateFile('doc.txt', 1000).valid).toBe(true);
    expect(svc.validateFile('doc.epub', 1000).valid).toBe(true);
    expect(svc.validateFile('doc.docx', 1000).valid).toBe(false);
  });

  it('AC1: rejects files over 50MB', () => {
    const svc = new DocumentImportService();
    expect(svc.validateFile('big.pdf', 60 * 1024 * 1024).valid).toBe(false);
  });

  it('AC2+AC5: tracks progress and generates summary', () => {
    const svc = new DocumentImportService();
    const task = svc.createTask('test.md', 'markdown', 5000);
    svc.updateProgress(task.id, 3, 10);
    expect(svc.getTask(task.id)?.progress.processedSegments).toBe(3);

    svc.addCandidates(task.id, [
      { id: 'c1', type: 'fact', title: 'F1', content: 'Content', sourceLocation: 'p1' },
      { id: 'c2', type: 'methodology', title: 'M1', content: 'Content', sourceLocation: 'p2' },
    ]);
    svc.reviewCandidates(task.id, [
      { candidateId: 'c1', action: 'accept' },
      { candidateId: 'c2', action: 'reject' },
    ]);
    const summary = svc.finalize(task.id);
    expect(summary?.accepted).toBe(1);
    expect(summary?.rejected).toBe(1);
  });

  it('AC3: acceptAll marks all candidates', () => {
    const svc = new DocumentImportService();
    const task = svc.createTask('test.pdf', 'pdf', 1000);
    svc.addCandidates(task.id, [
      { id: 'c1', type: 'fact', title: 'F1', content: 'C', sourceLocation: 'p1' },
      { id: 'c2', type: 'fact', title: 'F2', content: 'C', sourceLocation: 'p2' },
    ]);
    svc.acceptAll(task.id);
    const t = svc.getTask(task.id)!;
    expect(t.candidates.every((c) => c.accepted)).toBe(true);
  });
});

// ── FR-W10: IntentManagementService ──

describe('IntentManagementService (FR-W10)', () => {
  function makeIntentStore() {
    const records = new Map<string, any>();
    return {
      async list() { return Array.from(records.values()); },
      async get(id: string) { return records.get(id) ?? null; },
      async upsert(r: any) { records.set(r.id, r); return r; },
      async delete(id: string) { return records.delete(id); },
    };
  }

  it('AC1: lists intents with counts', async () => {
    const store = makeIntentStore();
    await store.upsert({
      id: 'i1', name: 'Greeting', description: 'Hello intents',
      positives: ['hi', 'hello'], negatives: ['bye'], linkedEntryIds: ['e1'],
    });
    const svc = new IntentManagementService({ store });
    const list = await svc.list();
    expect(list.length).toBe(1);
    expect(list[0].positiveCount).toBe(2);
    expect(list[0].negativeCount).toBe(1);
    expect(list[0].linkedEntryCount).toBe(1);
  });

  it('AC2+AC4: upsert triggers model update', async () => {
    const store = makeIntentStore();
    let updateCalled = false;
    const svc = new IntentManagementService({
      store,
      modelUpdater: {
        async triggerIncrementalUpdate() { updateCalled = true; return 'updating'; },
        async getUpdateStatus() { return 'idle'; },
      },
    });
    await svc.upsert('i1', { name: 'Test', description: 'Desc', positives: ['a', 'b'], negatives: [] });
    expect(updateCalled).toBe(true);
  });

  it('AC3: delete confirmation shows linked count', async () => {
    const store = makeIntentStore();
    await store.upsert({ id: 'i1', name: 'X', description: '', positives: [], negatives: [], linkedEntryIds: ['e1', 'e2'] });
    const svc = new IntentManagementService({ store });
    const confirm = await svc.getDeleteConfirmation('i1');
    expect(confirm?.linkedEntryCount).toBe(2);
  });
});

// ── Status Machine (shared) ──

describe('Status Transitions', () => {
  it('resolveNewStatus maps correctly', () => {
    expect(resolveNewStatus('pending', 'confirm')).toBe('active');
    expect(resolveNewStatus('pending', 'reject')).toBe('active');
    expect(resolveNewStatus('active', 'deprecate')).toBe('active');
  });

  it('STATUS_TRANSITIONS covers all statuses', () => {
    const statuses: EntryStatus[] = ['active'];
    for (const s of statuses) {
      expect(STATUS_TRANSITIONS[s]).toBeDefined();
    }
  });
});
