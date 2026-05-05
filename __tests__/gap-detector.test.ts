import { describe, expect, it } from 'vitest';
import { GapDetector } from '../src/research/index.js';
import type { KnowledgeEntry, KnowledgeSource } from '../src/types/index.js';

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'test://gap-detector',
  timestamp: new Date('2026-04-20T10:00:00.000Z'),
  agent: 'dev-01',
};

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = overrides.createdAt ?? new Date('2026-04-20T10:00:00.000Z');
  const updatedAt = overrides.updatedAt ?? new Date(createdAt.getTime());

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
    updatedAt,
    version: 1,
    ...overrides,
  };
}

describe('GapDetector', () => {
  it('identifies repeated query misses as frequency blind spots', () => {
    let now = new Date('2026-04-20T10:00:00.000Z');
    const detector = new GapDetector({
      now: () => now,
      idGenerator: () => 'gap-frequency',
    });

    detector.recordQueryMiss('How to run KIVO migration?');
    now = new Date('2026-04-20T10:05:00.000Z');
    detector.recordQueryMiss('how   to run kivo migration?', 'cli help');
    now = new Date('2026-04-20T10:10:00.000Z');
    detector.recordQueryMiss('HOW TO RUN KIVO MIGRATION?');

    const gaps = detector.detectFrequencyGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      id: 'gap-frequency',
      type: 'frequency_blind_spot',
      priority: 'medium',
    });
    expect(gaps[0].evidence).toMatchObject({
      pattern: 'How to run KIVO migration?',
      hitCount: 0,
      missCount: 3,
      lastMissAt: new Date('2026-04-20T10:10:00.000Z'),
    });
  });

  it('identifies structural gaps when a domain lacks knowledge chain types', () => {
    const detector = new GapDetector({ idGenerator: () => 'gap-structural' });
    const entries = [
      makeEntry({ id: 'f1', domain: 'growth', type: 'fact' }),
      makeEntry({ id: 'm1', domain: 'growth', type: 'methodology' }),
      makeEntry({ id: 'd1', domain: 'growth', type: 'decision' }),
      makeEntry({ id: 'x1', domain: 'ops', type: 'experience' }),
    ];

    const gaps = detector.detectStructuralGaps(entries);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({
      id: 'gap-structural',
      type: 'structural_gap',
    });
    expect(gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence: expect.objectContaining({
            domain: 'growth',
            presentTypes: ['fact', 'methodology', 'decision'],
            missingTypes: ['experience'],
          }),
          priority: 'medium',
        }),
        expect.objectContaining({
          evidence: expect.objectContaining({
            domain: 'ops',
            presentTypes: ['experience'],
            missingTypes: ['fact', 'methodology'],
          }),
          priority: 'high',
        }),
      ])
    );
  });

  it('sorts combined gaps by priority and generates research suggestions', () => {
    let sequence = 0;
    const detector = new GapDetector({
      idGenerator: () => `gap-${++sequence}`,
      now: () => new Date('2026-04-20T11:00:00.000Z'),
    });

    for (let index = 0; index < 5; index += 1) {
      detector.recordQueryMiss('OpenClaw browser lease failure');
    }

    const entries = [
      makeEntry({ id: 'growth-exp', domain: 'growth', type: 'experience' }),
      makeEntry({ id: 'growth-intent', domain: 'growth', type: 'intent' }),
      makeEntry({ id: 'ops-fact', domain: 'ops', type: 'fact' }),
      makeEntry({ id: 'ops-method', domain: 'ops', type: 'methodology' }),
    ];

    // Pass links to avoid graph gaps from isolated nodes
    const links = [
      { sourceId: 'growth-exp', targetId: 'growth-intent' },
      { sourceId: 'ops-fact', targetId: 'ops-method' },
      { sourceId: 'growth-exp', targetId: 'ops-fact' },
    ];

    const result = detector.detect(entries, links);

    expect(result.detectedAt).toEqual(new Date('2026-04-20T11:00:00.000Z'));
    expect(result.gaps).toHaveLength(3);
    expect(result.gaps.map((gap) => gap.priority)).toEqual(['high', 'high', 'medium']);
    expect(result.gaps[0].type).toBe('frequency_blind_spot');
    expect(result.suggestions).toHaveLength(3);
    expect(result.suggestions[0]).toMatchObject({
      gapId: result.gaps[0].id,
      priority: result.gaps[0].priority,
    });
    expect(result.suggestions[0].title).toContain('OpenClaw browser lease failure');
    expect(result.suggestions[1].description).toContain('growth');
  });

  it('returns empty results for empty data and protects miss history snapshots', () => {
    let now = new Date('2026-04-20T12:00:00.000Z');
    const detector = new GapDetector({ now: () => now });

    detector.recordQueryMiss('  ');
    detector.recordQueryMiss('missing topic', 'first context');

    const history = detector.getQueryMissHistory();
    expect(history).toHaveLength(1);
    history[0].query = 'mutated';
    history[0].timestamp = new Date('2000-01-01T00:00:00.000Z');

    now = new Date('2026-04-20T12:10:00.000Z');
    const snapshot = detector.getQueryMissHistory();
    expect(snapshot[0]).toMatchObject({
      query: 'missing topic',
      context: 'first context',
    });
    expect(snapshot[0].timestamp).toEqual(new Date('2026-04-20T12:00:00.000Z'));

    const empty = new GapDetector({ now: () => now }).detect([]);
    expect(empty.gaps).toEqual([]);
    expect(empty.suggestions).toEqual([]);
    expect(empty.detectedAt).toEqual(new Date('2026-04-20T12:10:00.000Z'));
  });
});
