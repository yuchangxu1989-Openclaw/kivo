import { describe, expect, it } from 'vitest';
import { BulkImporter, COMPATIBLE_FORMAT_VERSIONS } from '../src/bulk-import/index.js';
import type { BulkImportTarget } from '../src/bulk-import/index.js';
import type { ExportPackage } from '../src/bulk-export/index.js';
import { EXPORT_FORMAT_VERSION } from '../src/bulk-export/index.js';
import type { KnowledgeEntry } from '../src/types/index.js';

function makeEntry(id: string): KnowledgeEntry {
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
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
  };
}

function makePackage(entries: KnowledgeEntry[], version?: string): ExportPackage {
  return {
    formatVersion: version ?? EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    filter: {},
    entries,
    conflicts: [],
    totalEntries: entries.length,
    totalConflicts: 0,
  };
}

function makeTarget(existingIds: Set<string> = new Set()): BulkImportTarget & { saved: KnowledgeEntry[] } {
  const saved: KnowledgeEntry[] = [];
  return {
    saved,
    exists: async (id: string) => existingIds.has(id),
    save: async (entry: KnowledgeEntry) => { saved.push(entry); },
  };
}

describe('BulkImporter', () => {
  // ── AC1: 格式版本兼容性校验 ──

  describe('validateFormat', () => {
    it('accepts compatible version', () => {
      const target = makeTarget();
      const importer = new BulkImporter(target);
      const result = importer.validateFormat(makePackage([]));
      expect(result.valid).toBe(true);
    });

    it('rejects incompatible version', () => {
      const target = makeTarget();
      const importer = new BulkImporter(target);
      const result = importer.validateFormat(makePackage([], '99.0.0'));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('不兼容');
    });

    it('rejects missing version', () => {
      const target = makeTarget();
      const importer = new BulkImporter(target);
      const result = importer.validateFormat(makePackage([], ''));
      expect(result.valid).toBe(false);
    });
  });

  // ── AC2: 逐条冲突检测 ──

  it('imports new entries successfully', async () => {
    const target = makeTarget();
    const importer = new BulkImporter(target);
    const pkg = makePackage([makeEntry('e1'), makeEntry('e2')]);

    const report = await importer.import(pkg);
    expect(report.imported).toBe(2);
    expect(report.conflicts).toBe(0);
    expect(target.saved).toHaveLength(2);
  });

  it('marks conflicting entries as pending', async () => {
    const target = makeTarget(new Set(['e1']));
    const importer = new BulkImporter(target);
    const pkg = makePackage([makeEntry('e1'), makeEntry('e2')]);

    const report = await importer.import(pkg);
    expect(report.imported).toBe(1);
    expect(report.conflicts).toBe(1);
    // Conflicting entry saved with pending status and prefixed id
    const pendingEntry = target.saved.find(e => e.id === 'import-e1');
    expect(pendingEntry).toBeTruthy();
    expect(pendingEntry!.status).toBe('active');
  });

  // ── AC3: 导入报告 ──

  it('generates complete import report', async () => {
    const target = makeTarget(new Set(['e2']));
    const importer = new BulkImporter(target);
    const pkg = makePackage([makeEntry('e1'), makeEntry('e2'), makeEntry('e3')]);

    const report = await importer.import(pkg);
    expect(report.totalEntries).toBe(3);
    expect(report.imported).toBe(2);
    expect(report.conflicts).toBe(1);
    expect(report.dryRun).toBe(false);
    expect(report.startedAt).toBeTruthy();
    expect(report.completedAt).toBeTruthy();
  });

  // ── AC4: dry-run 模式 ──

  it('dry-run does not write entries', async () => {
    const target = makeTarget();
    const importer = new BulkImporter(target);
    const pkg = makePackage([makeEntry('e1'), makeEntry('e2')]);

    const report = await importer.import(pkg, { dryRun: true });
    expect(report.imported).toBe(2);
    expect(report.dryRun).toBe(true);
    expect(target.saved).toHaveLength(0); // nothing actually saved
  });

  it('dry-run reports conflicts without saving', async () => {
    const target = makeTarget(new Set(['e1']));
    const importer = new BulkImporter(target);
    const pkg = makePackage([makeEntry('e1')]);

    const report = await importer.import(pkg, { dryRun: true });
    expect(report.conflicts).toBe(1);
    expect(target.saved).toHaveLength(0);
  });

  // ── Format rejection ──

  it('rejects incompatible format before importing', async () => {
    const target = makeTarget();
    const importer = new BulkImporter(target);
    const pkg = makePackage([makeEntry('e1')], '99.0.0');

    const report = await importer.import(pkg);
    expect(report.imported).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].reason).toContain('不兼容');
  });

  // ── importFromJson ──

  it('imports from JSON string', async () => {
    const target = makeTarget();
    const importer = new BulkImporter(target);
    const json = JSON.stringify(makePackage([makeEntry('e1')]));

    const report = await importer.importFromJson(json);
    expect(report.imported).toBe(1);
  });

  it('handles invalid JSON', async () => {
    const target = makeTarget();
    const importer = new BulkImporter(target);

    const report = await importer.importFromJson('not json');
    expect(report.imported).toBe(0);
    expect(report.errors[0].reason).toContain('JSON');
  });

  // ── Error handling ──

  it('records errors for failed saves', async () => {
    const target: BulkImportTarget = {
      exists: async () => false,
      save: async () => { throw new Error('disk full'); },
    };
    const importer = new BulkImporter(target);
    const pkg = makePackage([makeEntry('e1')]);

    const report = await importer.import(pkg);
    expect(report.imported).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.errors[0].reason).toContain('disk full');
  });
});
