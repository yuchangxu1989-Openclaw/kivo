/**
 * CLI: kivo governance — FR-W13 意图治理视图
 *
 * Subcommands:
 *   run    — 执行一轮意图治理
 *   report — 查看最近的治理报告
 *   config — 查看/修改治理配置
 */

import { IntentGovernanceEngine } from '../intent-governance/intent-governance-engine.js';
import type {
  GovernanceConfig,
  GovernanceReport,
  GovernanceStore,
  GovernableIntent,
  MergeOperation,
} from '../intent-governance/governance-types.js';
import { DEFAULT_GOVERNANCE_CONFIG } from '../intent-governance/governance-types.js';

// ── In-memory store (standalone CLI; production wires to real persistence) ──

function createInMemoryStore(): GovernanceStore {
  const intents: GovernableIntent[] = [];
  const reports: GovernanceReport[] = [];
  const mergeOps: MergeOperation[] = [];

  return {
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

// ── Report formatting ──────────────────────────────────────────────────

function formatReport(report: GovernanceReport): string {
  const lines: string[] = [
    'Intent Governance Report',
    '='.repeat(40),
    '',
    `Run at:                  ${report.runAt.toISOString()}`,
    `Report ID:               ${report.id}`,
    `High-frequency themes:   ${report.highFrequencyThemesFound}`,
    `Merged entries:          ${report.mergedCount}`,
    `Boosted entries:         ${report.boostedCount}`,
    `Decayed entries:         ${report.decayedCount}`,
    `Pending cleanup:         ${report.pendingCleanupCount}`,
    '',
  ];

  if (report.clusters.length > 0) {
    lines.push('Clusters:');
    lines.push('-'.repeat(40));
    for (const c of report.clusters) {
      lines.push(`  Theme: ${c.theme} (${c.memberIds.length} members, avg similarity: ${c.avgSimilarity.toFixed(2)})`);
    }
    lines.push('');
  }

  if (report.weightChanges.length > 0) {
    lines.push('Weight Changes:');
    lines.push('-'.repeat(40));
    for (const w of report.weightChanges) {
      lines.push(`  ${w.intentId}: ${w.previousWeight.toFixed(2)} → ${w.newWeight.toFixed(2)} (${w.reason})`);
    }
    lines.push('');
  }

  if (report.mergeOperations.length > 0) {
    lines.push('Merge Operations:');
    lines.push('-'.repeat(40));
    for (const m of report.mergeOperations) {
      const sourceIds = m.sourceSnapshots.map(s => s.id).join(', ');
      lines.push(`  ${m.id}: merged [${sourceIds}] → ${m.resultId}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatConfig(config: GovernanceConfig): string {
  const lines: string[] = [
    'Governance Configuration',
    '='.repeat(40),
    '',
  ];

  const entries: [string, string][] = [
    ['scanWindowDays', String(config.scanWindowDays)],
    ['similarityThreshold', String(config.similarityThreshold)],
    ['highFrequencyMinCount', String(config.highFrequencyMinCount)],
    ['boostCoefficient', String(config.boostCoefficient)],
    ['weightCap', String(config.weightCap)],
    ['decayTriggerDays', String(config.decayTriggerDays)],
    ['decayFactor', String(config.decayFactor)],
    ['cleanupThreshold', String(config.cleanupThreshold)],
  ];

  for (const [key, value] of entries) {
    lines.push(`  ${key.padEnd(24)} ${value}`);
  }

  return lines.join('\n');
}

// ── Exported runners ───────────────────────────────────────────────────

export interface GovernanceRunOptions {
  store?: GovernanceStore;
  config?: Partial<GovernanceConfig>;
  json?: boolean;
}

export async function runGovernanceRun(options: GovernanceRunOptions = {}): Promise<string> {
  const store = options.store ?? createInMemoryStore();
  const engine = new IntentGovernanceEngine(store, options.config);
  const report = await engine.runGovernance();

  if (options.json) {
    return JSON.stringify(report, null, 2);
  }
  return formatReport(report);
}

export interface GovernanceReportOptions {
  store?: GovernanceStore;
  limit?: number;
  json?: boolean;
}

export async function runGovernanceReport(options: GovernanceReportOptions = {}): Promise<string> {
  const store = options.store ?? createInMemoryStore();
  const limit = options.limit ?? 5;
  const reports = await store.listReports(limit);

  if (reports.length === 0) {
    return 'No governance reports found. Run `kivo governance run` first.';
  }

  if (options.json) {
    return JSON.stringify(reports, null, 2);
  }

  return reports.map(r => formatReport(r)).join('\n' + '─'.repeat(40) + '\n');
}

export interface GovernanceConfigOptions {
  store?: GovernanceStore;
  set?: Record<string, string>;
  json?: boolean;
}

export async function runGovernanceConfig(options: GovernanceConfigOptions = {}): Promise<string> {
  const store = options.store ?? createInMemoryStore();
  const engine = new IntentGovernanceEngine(store);

  if (options.set && Object.keys(options.set).length > 0) {
    const patch: Partial<GovernanceConfig> = {};
    for (const [key, value] of Object.entries(options.set)) {
      if (key in DEFAULT_GOVERNANCE_CONFIG) {
        (patch as Record<string, number>)[key] = Number(value);
      }
    }
    engine.updateConfig(patch);
    const updated = engine.getConfig();
    if (options.json) {
      return JSON.stringify(updated, null, 2);
    }
    return 'Configuration updated.\n\n' + formatConfig(updated);
  }

  const config = engine.getConfig();
  if (options.json) {
    return JSON.stringify(config, null, 2);
  }
  return formatConfig(config);
}
