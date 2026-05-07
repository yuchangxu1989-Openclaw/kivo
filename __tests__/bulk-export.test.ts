import { describe, expect, it } from 'vitest';
import { BulkExporter, EXPORT_FORMAT_VERSION } from '../src/bulk-export/index.js';
import type { BulkExportDataSource, ExportFilter } from '../src/bulk-export/index.js';
import type { KnowledgeEntry } from '../src/types/index.js';
import type { ConflictRecord } from '../src/conflict/index.js';

function makeEntry(id: string, overrides?: Partial<KnowledgeEntry>): KnowledgeEntry {
  return {
    id,
    type: 'fact',
    title: `Entry ${id}`,
    content: `Content for ${id}`,
    summary: `Summary ${id}`,
    source: { type: 'manual', reference: 'test', timestamp: new Date() },
    confidence: 0.9,
    status: 'active',
    tags: [],
    domain: 'default',
    createdAt: new Date('2025-01-15'),
    updatedAt: new Date('2025-01-15'),
    version: 1,
    ...overrides,
  };
}

function makeConflict(incomingId: string, existingId: string): ConflictRecord {
  return {
    id: `c-${incomingId}-${existingId}`,
    incomingId,
    existingId,
    verdict: 'conflict',
    detectedAt: new Date(),
    resolved: false,
  };
}

function makeDataSource(entries: KnowledgeEntry[], conflicts: ConflictRecord[] = []): BulkExportDataSource {
  return {
    getAllEntries: async () => entries,
    getAllConflicts: async () => conflicts,
  };
}

describe('BulkExporter', () => {
  // ── AC3: 格式版本号 ──

  it('includes format version in export', async () => {
    const exporter = new BulkExporter(makeDataSource([]));
    const pkg = await exporter.export();
    expect(pkg.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(pkg.exportedAt).toBeTruthy();
  });

  // ── AC1: 筛选导出 ──

  it('exports all entries when no filter', async () => {
    const entries = [makeEntry('e1'), makeEntry('e2'), makeEntry('e3')];
    const exporter = new BulkExporter(makeDataSource(entries));
    const pkg = await exporter.export();
    expect(pkg.totalEntries).toBe(3);
  });

  it('filters by domain', async () => {
    const entries = [
      makeEntry('e1', { domain: 'eng' }),
      makeEntry('e2', { domain: 'finance' }),
      makeEntry('e3', { domain: 'eng' }),
    ];
    const exporter = new BulkExporter(makeDataSource(entries));
    const pkg = await exporter.export({ domains: ['eng'] });
    expect(pkg.totalEntries).toBe(2);
    expect(pkg.entries.every(e => e.domain === 'eng')).toBe(true);
  });

  it('filters by type', async () => {
    const entries = [
      makeEntry('e1', { type: 'fact' }),
      makeEntry('e2', { type: 'methodology' }),
    ];
    const exporter = new BulkExporter(makeDataSource(entries));
    const pkg = await exporter.export({ types: ['fact'] });
    expect(pkg.totalEntries).toBe(1);
  });

  it('filters by status', async () => {
    const entries = [
      makeEntry('e1', { status: 'active' }),
      makeEntry('e2', { status: 'active' }),
    ];
    const exporter = new BulkExporter(makeDataSource(entries));
    const pkg = await exporter.export({ statuses: ['active'] });
    expect(pkg.totalEntries).toBe(1);
  });

  it('filters by time range', async () => {
    const entries = [
      makeEntry('e1', { createdAt: new Date('2025-01-01') }),
      makeEntry('e2', { createdAt: new Date('2025-06-01') }),
      makeEntry('e3', { createdAt: new Date('2025-12-01') }),
    ];
    const exporter = new BulkExporter(makeDataSource(entries));
    const pkg = await exporter.export({
      timeRange: { start: new Date('2025-03-01'), end: new Date('2025-09-01') },
    });
    expect(pkg.totalEntries).toBe(1);
    expect(pkg.entries[0].id).toBe('e2');
  });

  // ── AC2: 包含冲突记录 ──

  it('includes related conflict records', async () => {
    const entries = [makeEntry('e1'), makeEntry('e2')];
    const conflicts = [
      makeConflict('e1', 'e2'),
      makeConflict('e3', 'e4'), // unrelated
    ];
    const exporter = new BulkExporter(makeDataSource(entries, conflicts));
    const pkg = await exporter.export();
    expect(pkg.totalConflicts).toBe(1);
    expect(pkg.conflicts[0].incomingId).toBe('e1');
  });

  it('exportToJson returns valid JSON string', async () => {
    const exporter = new BulkExporter(makeDataSource([makeEntry('e1')]));
    const json = await exporter.exportToJson();
    const parsed = JSON.parse(json);
    expect(parsed.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(parsed.entries).toHaveLength(1);
  });
});
