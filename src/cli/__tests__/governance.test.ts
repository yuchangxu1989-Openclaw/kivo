import { describe, expect, it } from 'vitest';
import {
  runGovernanceRun,
  runGovernanceReport,
  runGovernanceConfig,
} from '../governance.js';
import type {
  GovernableIntent,
  GovernanceStore,
  GovernanceReport,
  MergeOperation,
} from '../../intent-governance/governance-types.js';

function createTestStore(): GovernanceStore & {
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

// ── FR-W13 AC1: 意图条目列表展示治理指标 ──

describe('FR-W13 governance run', () => {
  it('AC1/AC5: runs governance and returns formatted report', async () => {
    const store = createTestStore();
    store.intents.push(
      makeIntent({ id: 'g1', name: '中文注释', description: '代码注释用中文', positives: ['中文注释'] }),
      makeIntent({ id: 'g2', name: '中文注释规范', description: '代码注释用中文', positives: ['中文注释'] }),
    );

    const output = await runGovernanceRun({ store, config: { similarityThreshold: 0.4 } });
    expect(output).toContain('Intent Governance Report');
    expect(output).toContain('Run at:');
    expect(output).toContain('Report ID:');
  });

  it('AC5: returns JSON when requested', async () => {
    const store = createTestStore();
    store.intents.push(makeIntent({ id: 'j1' }));

    const output = await runGovernanceRun({ store, json: true });
    const parsed = JSON.parse(output);
    expect(parsed.id).toBeTruthy();
    expect(parsed.runAt).toBeTruthy();
    expect(typeof parsed.highFrequencyThemesFound).toBe('number');
  });

  it('AC5: report persisted and retrievable', async () => {
    const store = createTestStore();
    store.intents.push(makeIntent({ id: 'p1' }));

    await runGovernanceRun({ store });
    expect(store.reports.length).toBe(1);

    const reportOutput = await runGovernanceReport({ store });
    expect(reportOutput).toContain('Intent Governance Report');
  });
});

// ── FR-W13 AC5: 治理报告历史列表 ──

describe('FR-W13 governance report', () => {
  it('AC5: shows message when no reports exist', async () => {
    const store = createTestStore();
    const output = await runGovernanceReport({ store });
    expect(output).toContain('No governance reports found');
  });

  it('AC5: lists multiple reports', async () => {
    const store = createTestStore();
    store.intents.push(makeIntent({ id: 'mr1' }));

    await runGovernanceRun({ store });
    await runGovernanceRun({ store });

    const output = await runGovernanceReport({ store, limit: 10 });
    // Should contain two report headers
    const matches = output.match(/Intent Governance Report/g);
    expect(matches).toBeTruthy();
    expect(matches!.length).toBe(2);
  });

  it('AC5: respects limit parameter', async () => {
    const store = createTestStore();
    store.intents.push(makeIntent({ id: 'lr1' }));

    await runGovernanceRun({ store });
    await runGovernanceRun({ store });
    await runGovernanceRun({ store });

    const output = await runGovernanceReport({ store, limit: 1 });
    const matches = output.match(/Intent Governance Report/g);
    expect(matches).toBeTruthy();
    expect(matches!.length).toBe(1);
  });
});

// ── FR-W13 AC6 (via FR-E06 AC6): 治理配置查看/修改 ──

describe('FR-W13 governance config', () => {
  it('shows current config', async () => {
    const store = createTestStore();
    const output = await runGovernanceConfig({ store });
    expect(output).toContain('Governance Configuration');
    expect(output).toContain('scanWindowDays');
    expect(output).toContain('similarityThreshold');
  });

  it('updates config with --set', async () => {
    const store = createTestStore();
    const output = await runGovernanceConfig({
      store,
      set: { scanWindowDays: '14', similarityThreshold: '0.9' },
    });
    expect(output).toContain('Configuration updated');
    expect(output).toContain('14');
    expect(output).toContain('0.9');
  });

  it('returns JSON when requested', async () => {
    const store = createTestStore();
    const output = await runGovernanceConfig({ store, json: true });
    const parsed = JSON.parse(output);
    expect(parsed.scanWindowDays).toBe(7);
    expect(parsed.similarityThreshold).toBe(0.75);
  });
});
