import { describe, expect, it } from 'vitest';
import { GapDetector, ResearchTaskGenerator } from '../src/research/index.js';
import type { KnowledgeEntry, KnowledgeSource } from '../src/types/index.js';
import type { KnowledgeLink } from '../src/research/gap-detector.js';

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'test://graph-gap',
  timestamp: new Date('2026-04-20T10:00:00.000Z'),
  agent: 'dev-01',
};

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = overrides.createdAt ?? new Date('2026-04-20T10:00:00.000Z');
  return {
    id,
    type: 'fact',
    title: `title-${id}`,
    content: `content-${id}`,
    summary: `summary-${id}`,
    source: testSource,
    confidence: 0.9,
    status: 'active',
    tags: ['core'],
    createdAt,
    updatedAt: new Date(createdAt),
    version: 1,
    ...overrides,
  };
}

describe('GapDetector — graph-based gap detection (FR-D01 AC3)', () => {
  it('detects isolated nodes (entries with no connections)', () => {
    let seq = 0;
    const detector = new GapDetector({ idGenerator: () => `gap-${++seq}` });

    const entries = [
      makeEntry({ id: 'a', domain: 'ops' }),
      makeEntry({ id: 'b', domain: 'ops' }),
      makeEntry({ id: 'c', domain: 'dev' }),
    ];

    // No links at all — all nodes are isolated
    const gaps = detector.detectGraphGaps(entries, []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].type).toBe('graph_gap');
    expect(gaps[0].evidence).toMatchObject({
      signal: 'isolated_node',
      affectedIds: ['a', 'b', 'c'],
    });
  });

  it('does not flag connected nodes as isolated', () => {
    const detector = new GapDetector();

    const entries = [
      makeEntry({ id: 'a', domain: 'ops' }),
      makeEntry({ id: 'b', domain: 'ops' }),
    ];

    const links: KnowledgeLink[] = [
      { sourceId: 'a', targetId: 'b' },
    ];

    const gaps = detector.detectGraphGaps(entries, links);
    const isolatedGaps = gaps.filter((g) => (g.evidence as any).signal === 'isolated_node');
    expect(isolatedGaps).toHaveLength(0);
  });

  it('detects sparse communities (low internal link density)', () => {
    let seq = 0;
    const detector = new GapDetector({ idGenerator: () => `gap-${++seq}` });

    // 4 entries in same domain, only 1 link → density = 1/6 ≈ 16.7% < 20%
    const entries = [
      makeEntry({ id: 'a', domain: 'infra' }),
      makeEntry({ id: 'b', domain: 'infra' }),
      makeEntry({ id: 'c', domain: 'infra' }),
      makeEntry({ id: 'd', domain: 'infra' }),
    ];

    const links: KnowledgeLink[] = [
      { sourceId: 'a', targetId: 'b' },
    ];

    const gaps = detector.detectGraphGaps(entries, links);
    const sparseGaps = gaps.filter((g) => (g.evidence as any).signal === 'sparse_community');
    expect(sparseGaps).toHaveLength(1);
    expect(sparseGaps[0].description).toContain('infra');
    expect(sparseGaps[0].description).toContain('4');
  });

  it('does not flag dense communities as sparse', () => {
    const detector = new GapDetector();

    // 3 entries, 3 links (fully connected) → density = 3/3 = 100%
    const entries = [
      makeEntry({ id: 'a', domain: 'core' }),
      makeEntry({ id: 'b', domain: 'core' }),
      makeEntry({ id: 'c', domain: 'core' }),
    ];

    const links: KnowledgeLink[] = [
      { sourceId: 'a', targetId: 'b' },
      { sourceId: 'b', targetId: 'c' },
      { sourceId: 'a', targetId: 'c' },
    ];

    const gaps = detector.detectGraphGaps(entries, links);
    const sparseGaps = gaps.filter((g) => (g.evidence as any).signal === 'sparse_community');
    expect(sparseGaps).toHaveLength(0);
  });

  it('detects missing bridge nodes between disconnected domains', () => {
    let seq = 0;
    const detector = new GapDetector({ idGenerator: () => `gap-${++seq}` });

    const entries = [
      makeEntry({ id: 'a1', domain: 'frontend' }),
      makeEntry({ id: 'a2', domain: 'frontend' }),
      makeEntry({ id: 'b1', domain: 'backend' }),
      makeEntry({ id: 'b2', domain: 'backend' }),
    ];

    // Internal links within each domain, but no cross-domain links
    const links: KnowledgeLink[] = [
      { sourceId: 'a1', targetId: 'a2' },
      { sourceId: 'b1', targetId: 'b2' },
    ];

    const gaps = detector.detectGraphGaps(entries, links);
    const bridgeGaps = gaps.filter((g) => (g.evidence as any).signal === 'missing_bridge');
    expect(bridgeGaps).toHaveLength(1);
    expect(bridgeGaps[0].description).toContain('frontend');
    expect(bridgeGaps[0].description).toContain('backend');
  });

  it('does not flag bridge gap when cross-domain links exist', () => {
    const detector = new GapDetector();

    const entries = [
      makeEntry({ id: 'a1', domain: 'frontend' }),
      makeEntry({ id: 'a2', domain: 'frontend' }),
      makeEntry({ id: 'b1', domain: 'backend' }),
      makeEntry({ id: 'b2', domain: 'backend' }),
    ];

    const links: KnowledgeLink[] = [
      { sourceId: 'a1', targetId: 'a2' },
      { sourceId: 'b1', targetId: 'b2' },
      { sourceId: 'a1', targetId: 'b1' }, // cross-domain bridge
    ];

    const gaps = detector.detectGraphGaps(entries, links);
    const bridgeGaps = gaps.filter((g) => (g.evidence as any).signal === 'missing_bridge');
    expect(bridgeGaps).toHaveLength(0);
  });

  it('assigns higher priority to larger isolated node sets', () => {
    let seq = 0;
    const detector = new GapDetector({ idGenerator: () => `gap-${++seq}` });

    const entries = Array.from({ length: 6 }, (_, i) =>
      makeEntry({ id: `iso-${i}`, domain: 'misc' })
    );

    const gaps = detector.detectGraphGaps(entries, []);
    const isolatedGap = gaps.find((g) => (g.evidence as any).signal === 'isolated_node');
    expect(isolatedGap).toBeDefined();
    expect(isolatedGap!.priority).toBe('high'); // >= 5 isolated nodes
  });
});

describe('GapDetector — coverage analysis (FR-D01 AC6)', () => {
  it('calculates hit rate and compares against baseline', () => {
    const detector = new GapDetector({ coverageBaseline: 0.8 });

    // 8 hits, 2 misses → 80% hit rate
    for (let i = 0; i < 8; i++) detector.recordQueryHit();
    detector.recordQueryMiss('missing-1');
    detector.recordQueryMiss('missing-2');

    const analysis = detector.analyzeCoverage([]);
    expect(analysis.totalQueries).toBe(10);
    expect(analysis.hitCount).toBe(8);
    expect(analysis.missCount).toBe(2);
    expect(analysis.hitRate).toBe(0.8);
    expect(analysis.baseline).toBe(0.8);
    expect(analysis.meetsBaseline).toBe(true);
  });

  it('reports below baseline when hit rate is insufficient', () => {
    const detector = new GapDetector({ coverageBaseline: 0.9 });

    for (let i = 0; i < 7; i++) detector.recordQueryHit();
    for (let i = 0; i < 3; i++) detector.recordQueryMiss(`miss-${i}`);

    const analysis = detector.analyzeCoverage([]);
    expect(analysis.hitRate).toBe(0.7);
    expect(analysis.meetsBaseline).toBe(false);
  });

  it('provides per-domain coverage based on knowledge chain completeness', () => {
    const detector = new GapDetector();

    const entries = [
      makeEntry({ id: 'f1', domain: 'ops', type: 'fact' }),
      makeEntry({ id: 'm1', domain: 'ops', type: 'methodology' }),
      makeEntry({ id: 'e1', domain: 'ops', type: 'experience' }),
      makeEntry({ id: 'f2', domain: 'dev', type: 'fact' }),
      // dev is missing methodology and experience
    ];

    const analysis = detector.analyzeCoverage(entries);
    const opsCoverage = analysis.domainCoverage.get('ops');
    const devCoverage = analysis.domainCoverage.get('dev');

    expect(opsCoverage).toMatchObject({ total: 3, covered: 3, rate: 1 });
    expect(devCoverage).toMatchObject({ total: 3, covered: 1 });
    expect(devCoverage!.rate).toBeCloseTo(1 / 3);
  });

  it('allows overriding baseline per call', () => {
    const detector = new GapDetector({ coverageBaseline: 0.5 });

    for (let i = 0; i < 6; i++) detector.recordQueryHit();
    for (let i = 0; i < 4; i++) detector.recordQueryMiss(`miss-${i}`);

    const defaultAnalysis = detector.analyzeCoverage([]);
    expect(defaultAnalysis.meetsBaseline).toBe(true); // 60% >= 50%

    const strictAnalysis = detector.analyzeCoverage([], { baseline: 0.8 });
    expect(strictAnalysis.meetsBaseline).toBe(false); // 60% < 80%
  });

  it('returns 100% hit rate when no queries recorded', () => {
    const detector = new GapDetector();
    const analysis = detector.analyzeCoverage([]);
    expect(analysis.hitRate).toBe(1);
    expect(analysis.meetsBaseline).toBe(true);
  });
});

describe('GapDetector — one-click task creation (FR-D01 AC5)', () => {
  it('creates a research task from a suggestion', () => {
    let gapSeq = 0;
    const detector = new GapDetector({
      idGenerator: () => `gap-${++gapSeq}`,
      now: () => new Date('2026-04-20T12:00:00.000Z'),
    });

    for (let i = 0; i < 5; i++) detector.recordQueryMiss('KIVO migration guide');

    const result = detector.detect([], []);
    expect(result.suggestions.length).toBeGreaterThan(0);

    const suggestion = result.suggestions[0];
    let taskSeq = 0;
    const generator = new ResearchTaskGenerator({
      idGenerator: () => `task-${++taskSeq}`,
      now: () => new Date('2026-04-20T12:05:00.000Z'),
    });

    const task = detector.createTaskFromSuggestion(suggestion, result.gaps, generator);
    expect(task.gapId).toBe(suggestion.gapId);
    expect(task.title).toContain('KIVO migration guide');
  });

  it('throws when gap not found for suggestion', () => {
    const detector = new GapDetector();
    const generator = new ResearchTaskGenerator();

    expect(() =>
      detector.createTaskFromSuggestion(
        { gapId: 'nonexistent', title: 'test', description: 'test', expectedOutcome: 'test', priority: 'low' },
        [],
        generator,
      )
    ).toThrow('Gap "nonexistent" not found');
  });
});
