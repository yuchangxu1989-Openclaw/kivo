import { beforeEach, describe, expect, it } from 'vitest';
import { IntentGovernanceEngine } from '../intent-governance-engine.js';
import type {
  GovernableIntent,
  GovernanceStore,
  GovernanceReport,
  MergeOperation,
  GovernanceConfig,
} from '../governance-types.js';
import { DEFAULT_GOVERNANCE_CONFIG } from '../governance-types.js';

// ── In-memory store ────────────────────────────────────────────────────

function createMockStore(): GovernanceStore & {
  intents: GovernableIntent[];
  reports: GovernanceReport[];
  mergeOps: MergeOperation[];
} {
  const intents: GovernableIntent[] = [];
  const reports: GovernanceReport[] = [];
  const mergeOps: MergeOperation[] = [];

  return {
    intents,
    reports,
    mergeOps,
    async listActive() {
      return intents.filter(i => i.governanceStatus !== 'merged');
    },
    async update(intent) {
      const idx = intents.findIndex(i => i.id === intent.id);
      if (idx >= 0) intents[idx] = { ...intent };
      else intents.push({ ...intent });
    },
    async updateMany(updated) {
      for (const u of updated) {
        const idx = intents.findIndex(i => i.id === u.id);
        if (idx >= 0) intents[idx] = { ...u };
      }
    },
    async create(intent) {
      intents.push({ ...intent });
      return intent;
    },
    async saveMergeOperation(op) {
      const idx = mergeOps.findIndex(o => o.id === op.id);
      if (idx >= 0) mergeOps[idx] = { ...op };
      else mergeOps.push({ ...op });
    },
    async getMergeOperation(id) {
      return mergeOps.find(o => o.id === id) ?? null;
    },
    async saveReport(report) {
      reports.push({ ...report });
    },
    async listReports(limit = 10) {
      return reports.slice(-limit);
    },
  };
}

function makeIntent(overrides: Partial<GovernableIntent> = {}): GovernableIntent {
  return {
    id: `intent-${Math.random().toString(36).slice(2, 8)}`,
    name: 'test intent',
    description: 'test description',
    positives: ['positive example'],
    negatives: ['negative example'],
    linkedEntryIds: [],
    weight: 1.0,
    lastHitAt: new Date(),
    governanceStatus: 'active',
    createdAt: new Date('2026-04-01'),
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// AC1: 语义聚类 — 识别高频主题
// ═════════════════════════════════════════════════════════════════════════

describe('FR-E06 AC1: semantic clustering', () => {
  it('clusters similar intents together', () => {
    const store = createMockStore();
    const engine = new IntentGovernanceEngine(store, { similarityThreshold: 0.5 });

    const intents: GovernableIntent[] = [
      makeIntent({ id: 'a', name: '代码注释中文', description: '代码注释用中文写', positives: ['代码注释用中文写'] }),
      makeIntent({ id: 'b', name: '代码注释中文', description: '代码注释用中文写', positives: ['代码注释用中文写'] }),
      makeIntent({ id: 'c', name: '部署流程步骤', description: '部署到生产环境的步骤', positives: ['部署生产环境'] }),
    ];

    const clusters = engine.clusterIntents(intents);
    // a and b should cluster together, c should be separate
    const abCluster = clusters.find(c => c.memberIds.includes('a') && c.memberIds.includes('b'));
    expect(abCluster).toBeDefined();
    expect(abCluster!.memberIds.length).toBe(2);
  });

  it('returns singleton clusters for dissimilar intents', () => {
    const store = createMockStore();
    const engine = new IntentGovernanceEngine(store, { similarityThreshold: 0.9 });

    const intents: GovernableIntent[] = [
      makeIntent({ id: 'x', name: 'alpha', description: 'completely different topic A', positives: ['aaa'] }),
      makeIntent({ id: 'y', name: 'beta', description: 'completely different topic B', positives: ['bbb'] }),
    ];

    const clusters = engine.clusterIntents(intents);
    expect(clusters.length).toBe(2);
    expect(clusters.every(c => c.memberIds.length === 1)).toBe(true);
  });

  it('returns empty array for empty input', () => {
    const store = createMockStore();
    const engine = new IntentGovernanceEngine(store);
    expect(engine.clusterIntents([])).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// AC2: 高频主题权重提升
// ═════════════════════════════════════════════════════════════════════════

describe('FR-E06 AC2: high-frequency weight boost', () => {
  it('boosts weight for intents in high-frequency clusters', async () => {
    const store = createMockStore();
    // Create 3 very similar intents (high frequency)
    store.intents.push(
      makeIntent({ id: 'h1', name: '中文注释', description: '代码注释用中文', positives: ['中文注释代码'], weight: 1.0 }),
      makeIntent({ id: 'h2', name: '中文注释规范', description: '代码注释用中文', positives: ['中文注释代码'], weight: 1.0 }),
      makeIntent({ id: 'h3', name: '中文注释要求', description: '代码注释用中文', positives: ['中文注释代码'], weight: 1.0 }),
    );

    const engine = new IntentGovernanceEngine(store, {
      similarityThreshold: 0.5,
      highFrequencyMinCount: 3,
      boostCoefficient: 0.1,
      weightCap: 2.0,
    });

    const report = await engine.runGovernance();
    expect(report.boostedCount).toBeGreaterThan(0);
    // Weight changes should include boost entries
    const boosts = report.weightChanges.filter(w => w.reason === 'boost');
    expect(boosts.length).toBeGreaterThan(0);
    for (const b of boosts) {
      expect(b.newWeight).toBeGreaterThan(b.previousWeight);
    }
  });

  it('respects weight cap', async () => {
    const store = createMockStore();
    // Create intents already near cap
    for (let i = 0; i < 5; i++) {
      store.intents.push(
        makeIntent({ id: `cap-${i}`, name: '同一主题', description: '完全相同的内容', positives: ['相同'], weight: 1.9 }),
      );
    }

    const engine = new IntentGovernanceEngine(store, {
      similarityThreshold: 0.5,
      highFrequencyMinCount: 3,
      boostCoefficient: 0.5,
      weightCap: 2.0,
    });

    const report = await engine.runGovernance();
    const boosts = report.weightChanges.filter(w => w.reason === 'boost');
    for (const b of boosts) {
      expect(b.newWeight).toBeLessThanOrEqual(2.0);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// AC3: 语义重复自动合并
// ═════════════════════════════════════════════════════════════════════════

describe('FR-E06 AC3: auto-merge duplicates', () => {
  it('merges semantically duplicate intents', async () => {
    const store = createMockStore();
    store.intents.push(
      makeIntent({
        id: 'm1',
        name: '中文注释',
        description: '代码注释用中文',
        positives: ['注释用中文', '中文注释'],
        negatives: ['英文注释'],
        linkedEntryIds: ['e1'],
      }),
      makeIntent({
        id: 'm2',
        name: '中文注释规范',
        description: '代码注释用中文',
        positives: ['中文注释', '注释中文化'],
        negatives: ['日文注释'],
        linkedEntryIds: ['e2'],
      }),
    );

    const engine = new IntentGovernanceEngine(store, {
      similarityThreshold: 0.4,
      highFrequencyMinCount: 100, // disable boost for this test
    });

    const report = await engine.runGovernance();
    expect(report.mergedCount).toBe(2);
    expect(report.mergeOperations.length).toBe(1);

    // Merged intent should have union of positives and negatives
    const mergedOp = report.mergeOperations[0];
    const mergedIntent = store.intents.find(i => i.id === mergedOp.resultId);
    expect(mergedIntent).toBeDefined();
    expect(mergedIntent!.positives).toContain('注释用中文');
    expect(mergedIntent!.positives).toContain('注释中文化');
    expect(mergedIntent!.negatives).toContain('英文注释');
    expect(mergedIntent!.negatives).toContain('日文注释');
    expect(mergedIntent!.mergedFromIds).toContain('m1');
    expect(mergedIntent!.mergedFromIds).toContain('m2');
  });

  it('does not merge dissimilar intents', async () => {
    const store = createMockStore();
    store.intents.push(
      makeIntent({ id: 'x1', name: 'alpha topic', description: 'completely different A', positives: ['aaa'] }),
      makeIntent({ id: 'x2', name: 'beta topic', description: 'completely different B', positives: ['bbb'] }),
    );

    const engine = new IntentGovernanceEngine(store, { similarityThreshold: 0.9 });
    const report = await engine.runGovernance();
    expect(report.mergedCount).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// AC4: 权重衰减 + pending_cleanup
// ═════════════════════════════════════════════════════════════════════════

describe('FR-E06 AC4: weight decay and pending_cleanup', () => {
  it('decays weight for intents not hit within decay window', async () => {
    const store = createMockStore();
    const oldDate = new Date(Date.now() - 60 * 86400000); // 60 days ago
    store.intents.push(
      makeIntent({ id: 'd1', name: 'old intent', description: 'unique old topic xyz', positives: ['xyz'], weight: 1.0, lastHitAt: oldDate }),
    );

    const engine = new IntentGovernanceEngine(store, {
      decayTriggerDays: 30,
      decayFactor: 0.8,
      cleanupThreshold: 0.2,
      similarityThreshold: 0.99, // prevent merging
    });

    const report = await engine.runGovernance();
    const decays = report.weightChanges.filter(w => w.reason === 'decay');
    expect(decays.length).toBe(1);
    expect(decays[0].newWeight).toBe(0.8); // 1.0 * 0.8
  });

  it('marks intent as pending_cleanup when weight drops below threshold', async () => {
    const store = createMockStore();
    const oldDate = new Date(Date.now() - 60 * 86400000);
    store.intents.push(
      makeIntent({ id: 'd2', name: 'dying intent', description: 'unique dying topic abc', positives: ['abc'], weight: 0.15, lastHitAt: oldDate }),
    );

    const engine = new IntentGovernanceEngine(store, {
      decayTriggerDays: 30,
      decayFactor: 0.8,
      cleanupThreshold: 0.2,
      similarityThreshold: 0.99,
    });

    const report = await engine.runGovernance();
    expect(report.pendingCleanupCount).toBe(1);
    const intent = store.intents.find(i => i.id === 'd2');
    expect(intent!.governanceStatus).toBe('pending_cleanup');
  });

  it('does not decay recently hit intents', async () => {
    const store = createMockStore();
    store.intents.push(
      makeIntent({ id: 'd3', name: 'fresh intent', description: 'unique fresh topic qrs', positives: ['qrs'], weight: 1.0, lastHitAt: new Date() }),
    );

    const engine = new IntentGovernanceEngine(store, {
      decayTriggerDays: 30,
      similarityThreshold: 0.99,
    });

    const report = await engine.runGovernance();
    const decays = report.weightChanges.filter(w => w.reason === 'decay' && w.intentId === 'd3');
    expect(decays).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// AC5: 治理报告
// ═════════════════════════════════════════════════════════════════════════

describe('FR-E06 AC5: governance report', () => {
  it('generates and persists a governance report', async () => {
    const store = createMockStore();
    store.intents.push(
      makeIntent({ id: 'r1', name: 'report test', description: 'unique report topic', positives: ['report'] }),
    );

    const engine = new IntentGovernanceEngine(store);
    const report = await engine.runGovernance();

    expect(report.id).toBeTruthy();
    expect(report.runAt).toBeInstanceOf(Date);
    expect(report.config).toBeDefined();
    expect(typeof report.highFrequencyThemesFound).toBe('number');
    expect(typeof report.mergedCount).toBe('number');
    expect(typeof report.boostedCount).toBe('number');
    expect(typeof report.decayedCount).toBe('number');
    expect(typeof report.pendingCleanupCount).toBe('number');

    // Report should be persisted
    expect(store.reports.length).toBe(1);
    expect(store.reports[0].id).toBe(report.id);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// AC6: 配置可调
// ═════════════════════════════════════════════════════════════════════════

describe('FR-E06 AC6: configurable parameters', () => {
  it('uses default config when none provided', () => {
    const store = createMockStore();
    const engine = new IntentGovernanceEngine(store);
    expect(engine.getConfig()).toEqual(DEFAULT_GOVERNANCE_CONFIG);
  });

  it('supports runtime config update', () => {
    const store = createMockStore();
    const engine = new IntentGovernanceEngine(store);
    engine.updateConfig({ scanWindowDays: 14, similarityThreshold: 0.9 });
    const config = engine.getConfig();
    expect(config.scanWindowDays).toBe(14);
    expect(config.similarityThreshold).toBe(0.9);
    // Other values unchanged
    expect(config.boostCoefficient).toBe(DEFAULT_GOVERNANCE_CONFIG.boostCoefficient);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// AC7: 操作可回退
// ═════════════════════════════════════════════════════════════════════════

describe('FR-E06 AC7: reversible operations', () => {
  it('reverts a merge operation', async () => {
    const store = createMockStore();
    store.intents.push(
      makeIntent({ id: 'rv1', name: '中文注释', description: '代码注释用中文', positives: ['中文注释代码'] }),
      makeIntent({ id: 'rv2', name: '中文注释规范', description: '代码注释用中文', positives: ['中文注释代码'] }),
    );

    const engine = new IntentGovernanceEngine(store, {
      similarityThreshold: 0.4,
      highFrequencyMinCount: 100,
    });

    const report = await engine.runGovernance();
    expect(report.mergeOperations.length).toBe(1);

    const mergeOpId = report.mergeOperations[0].id;
    const reverted = await engine.revertMerge(mergeOpId);
    expect(reverted).toBe(true);

    // Original intents should be active again
    const rv1 = store.intents.find(i => i.id === 'rv1');
    const rv2 = store.intents.find(i => i.id === 'rv2');
    expect(rv1!.governanceStatus).toBe('active');
    expect(rv2!.governanceStatus).toBe('active');
  });

  it('cancels pending_cleanup marking', async () => {
    const store = createMockStore();
    const oldDate = new Date(Date.now() - 60 * 86400000);
    store.intents.push(
      makeIntent({ id: 'cl1', name: 'cleanup target', description: 'unique cleanup topic', positives: ['cleanup'], weight: 0.1, lastHitAt: oldDate }),
    );

    const engine = new IntentGovernanceEngine(store, {
      decayTriggerDays: 30,
      decayFactor: 0.8,
      cleanupThreshold: 0.2,
      similarityThreshold: 0.99,
    });

    await engine.runGovernance();
    const intent = store.intents.find(i => i.id === 'cl1');
    expect(intent!.governanceStatus).toBe('pending_cleanup');

    const cancelled = await engine.cancelCleanup('cl1');
    expect(cancelled).toBe(true);
    expect(intent!.governanceStatus).toBe('active');
    expect(intent!.weight).toBeGreaterThanOrEqual(0.2);
  });

  it('allows manual weight override', async () => {
    const store = createMockStore();
    store.intents.push(
      makeIntent({ id: 'wo1', name: 'weight override', description: 'unique override topic', positives: ['override'], weight: 0.5 }),
    );

    const engine = new IntentGovernanceEngine(store);
    await engine.overrideWeight('wo1', 1.5);
    const intent = store.intents.find(i => i.id === 'wo1');
    expect(intent!.weight).toBe(1.5);
  });
});
