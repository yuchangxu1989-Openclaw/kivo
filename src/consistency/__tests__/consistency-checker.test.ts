import { describe, expect, it } from 'vitest';
import { ConsistencyChecker } from '../consistency-checker.js';
import type { KnowledgeEntry } from '../../types/index.js';

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    type: 'fact',
    title: 'Test Entry',
    content: 'Test content',
    summary: 'Test summary',
    source: {
      type: 'manual',
      reference: 'test-source',
      timestamp: new Date(),
    },
    confidence: 0.8,
    status: 'active',
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

describe('FR-Z09: ConsistencyChecker', () => {
  const checker = new ConsistencyChecker();

  // ── AC1/AC2: Contradiction detection ──

  it('detects contradicting entries with opposing polarity', () => {
    const entries = [
      makeEntry({
        id: 'a1',
        type: 'intent',
        title: '代码注释语言',
        content: '代码注释必须使用中文',
      }),
      makeEntry({
        id: 'a2',
        type: 'intent',
        title: '代码注释语言规范',
        content: '代码注释禁止使用中文',
      }),
    ];

    const report = checker.check(entries, { similarityThreshold: 0.3 });
    expect(report.passed).toBe(false);
    expect(report.summary.errors).toBeGreaterThan(0);
    const contradictions = report.issues.filter(i => i.category === 'contradiction');
    expect(contradictions.length).toBeGreaterThan(0);
    expect(contradictions[0].entryIdA).toBe('a1');
    expect(contradictions[0].entryIdB).toBe('a2');
  });

  it('does not flag entries with same polarity', () => {
    const entries = [
      makeEntry({
        id: 'b1',
        type: 'intent',
        title: '代码注释语言',
        content: '代码注释必须使用中文',
      }),
      makeEntry({
        id: 'b2',
        type: 'intent',
        title: '代码注释语言规范',
        content: '代码注释应当使用中文',
      }),
    ];

    const report = checker.check(entries, { similarityThreshold: 0.3 });
    const contradictions = report.issues.filter(i => i.category === 'contradiction');
    expect(contradictions.length).toBe(0);
  });

  it('does not compare entries of different types', () => {
    const entries = [
      makeEntry({
        id: 'c1',
        type: 'fact',
        title: '代码注释语言',
        content: '代码注释必须使用中文',
      }),
      makeEntry({
        id: 'c2',
        type: 'intent',
        title: '代码注释语言规范',
        content: '代码注释禁止使用中文',
      }),
    ];

    const report = checker.check(entries, { similarityThreshold: 0.3 });
    const contradictions = report.issues.filter(i => i.category === 'contradiction');
    expect(contradictions.length).toBe(0);
  });

  // ── Stale reference detection ──

  it('detects stale dependency references', () => {
    const entries = [
      makeEntry({
        id: 'd1',
        title: 'Active entry',
        content: 'Depends on archived entry',
        dependencies: [{ ref: 'd2', relation: 'requires' }],
      }),
      makeEntry({
        id: 'd2',
        title: 'Archived entry',
        content: 'Old content',
        status: 'active',
      }),
    ];

    const report = checker.check(entries);
    const staleRefs = report.issues.filter(i => i.category === 'stale-reference');
    expect(staleRefs.length).toBe(1);
    expect(staleRefs[0].severity).toBe('error'); // requires = error
    expect(staleRefs[0].entryIdA).toBe('d1');
    expect(staleRefs[0].entryIdB).toBe('d2');
  });

  it('detects superseded entry still active', () => {
    const entries = [
      makeEntry({
        id: 'e1',
        title: 'New version',
        content: 'Updated content',
        supersedes: 'e2',
      }),
      makeEntry({
        id: 'e2',
        title: 'Old version',
        content: 'Original content',
        status: 'active',
      }),
    ];

    const report = checker.check(entries);
    const staleRefs = report.issues.filter(i => i.category === 'stale-reference');
    expect(staleRefs.length).toBe(1);
    expect(staleRefs[0].severity).toBe('warning');
  });

  // ── Missing source detection ──

  it('detects entries with missing source reference', () => {
    const entries = [
      makeEntry({
        id: 'f1',
        title: 'No source',
        source: { type: 'manual', reference: '', timestamp: new Date() },
      }),
    ];

    const report = checker.check(entries);
    const missingSrc = report.issues.filter(i => i.category === 'missing-source');
    expect(missingSrc.length).toBe(1);
  });

  it('detects entries with "unknown" source reference', () => {
    const entries = [
      makeEntry({
        id: 'f2',
        title: 'Unknown source',
        source: { type: 'manual', reference: 'unknown', timestamp: new Date() },
      }),
    ];

    const report = checker.check(entries);
    const missingSrc = report.issues.filter(i => i.category === 'missing-source');
    expect(missingSrc.length).toBe(1);
  });

  // ── Filtering ──

  it('filters by type', () => {
    const entries = [
      makeEntry({ id: 'g1', type: 'fact', title: '代码注释', content: '必须使用中文' }),
      makeEntry({ id: 'g2', type: 'fact', title: '代码注释规范', content: '禁止使用中文' }),
      makeEntry({ id: 'g3', type: 'intent', title: '代码注释', content: '必须使用中文' }),
      makeEntry({ id: 'g4', type: 'intent', title: '代码注释规范', content: '禁止使用中文' }),
    ];

    const report = checker.check(entries, { types: ['fact'], similarityThreshold: 0.3 });
    expect(report.totalEntries).toBe(2);
  });

  it('filters by domain', () => {
    const entries = [
      makeEntry({ id: 'h1', domain: 'coding', title: 'A', content: '必须使用中文' }),
      makeEntry({ id: 'h2', domain: 'coding', title: 'B', content: '禁止使用中文' }),
      makeEntry({ id: 'h3', domain: 'ops', title: 'C', content: '必须使用中文' }),
    ];

    const report = checker.check(entries, { domains: ['coding'], similarityThreshold: 0.3 });
    expect(report.totalEntries).toBe(2);
  });

  // ── Strict mode ──

  it('strict mode fails on warnings', () => {
    const entries = [
      makeEntry({
        id: 'i1',
        title: 'No source',
        source: { type: 'manual', reference: '', timestamp: new Date() },
      }),
    ];

    const normalReport = checker.check(entries, { strict: false });
    expect(normalReport.passed).toBe(true); // only warnings

    const strictReport = checker.check(entries, { strict: true });
    expect(strictReport.passed).toBe(false); // warnings count as failures
  });

  // ── Pass case ──

  it('passes when no issues found', () => {
    const entries = [
      makeEntry({ id: 'j1', title: 'Entry A', content: 'Completely different topic alpha' }),
      makeEntry({ id: 'j2', title: 'Entry B', content: 'Completely different topic beta' }),
    ];

    const report = checker.check(entries);
    expect(report.passed).toBe(true);
    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBe(0);
  });

  it('passes with empty entries', () => {
    const report = checker.check([]);
    expect(report.passed).toBe(true);
    expect(report.totalEntries).toBe(0);
  });

  // ── CI exit code ──

  it('report.passed maps to CI exit code semantics', () => {
    const clean = checker.check([makeEntry({ id: 'k1' })]);
    expect(clean.passed).toBe(true); // exit 0

    const dirty = checker.check([
      makeEntry({ id: 'k2', type: 'intent', title: '代码注释', content: '必须使用中文' }),
      makeEntry({ id: 'k3', type: 'intent', title: '代码注释规范', content: '禁止使用中文' }),
    ], { similarityThreshold: 0.3 });
    expect(dirty.passed).toBe(false); // exit 1
  });
});
