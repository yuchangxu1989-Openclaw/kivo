/**
 * CLI: kivo consistency-check — FR-Z09 知识条目一致性门禁
 *
 * Checks knowledge entries for contradictions, stale references,
 * and semantic drift. Exit code 1 if errors found (CI integration).
 */

import { ConsistencyChecker } from '../consistency/consistency-checker.js';
import type { ConsistencyReport, ConsistencyCheckOptions } from '../consistency/consistency-types.js';
import type { KnowledgeEntry } from '../types/index.js';

export function formatConsistencyReport(report: ConsistencyReport): string {
  const lines: string[] = [
    'Knowledge Consistency Report',
    '='.repeat(40),
    '',
    `Checked at:       ${report.checkedAt.toISOString()}`,
    `Total entries:    ${report.totalEntries}`,
    `Pairs compared:   ${report.pairsCompared}`,
    `Errors:           ${report.summary.errors}`,
    `Warnings:         ${report.summary.warnings}`,
    `Status:           ${report.passed ? 'PASSED' : 'FAILED'}`,
    '',
  ];

  if (report.issues.length === 0) {
    lines.push('No consistency issues found.');
    return lines.join('\n');
  }

  const errors = report.issues.filter(i => i.severity === 'error');
  const warnings = report.issues.filter(i => i.severity === 'warning');

  if (errors.length > 0) {
    lines.push('Errors:');
    lines.push('-'.repeat(40));
    for (const issue of errors) {
      lines.push(`  [${issue.category}] ${issue.description}`);
      lines.push(`    Entry A: ${issue.entryIdA} (${issue.titleA})`);
      if (issue.entryIdB) {
        lines.push(`    Entry B: ${issue.entryIdB} (${issue.titleB})`);
      }
      if (issue.similarityScore !== undefined) {
        lines.push(`    Similarity: ${issue.similarityScore.toFixed(2)}`);
      }
      lines.push('');
    }
  }

  if (warnings.length > 0) {
    lines.push('Warnings:');
    lines.push('-'.repeat(40));
    for (const issue of warnings) {
      lines.push(`  [${issue.category}] ${issue.description}`);
      lines.push(`    Entry A: ${issue.entryIdA} (${issue.titleA})`);
      if (issue.entryIdB) {
        lines.push(`    Entry B: ${issue.entryIdB} (${issue.titleB})`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

export interface ConsistencyCheckRunOptions {
  entries: KnowledgeEntry[];
  options?: ConsistencyCheckOptions;
  json?: boolean;
}

export function runConsistencyCheck(opts: ConsistencyCheckRunOptions): {
  report: ConsistencyReport;
  output: string;
} {
  const checker = new ConsistencyChecker();
  const report = checker.check(opts.entries, opts.options);

  const output = opts.json
    ? JSON.stringify(report, null, 2)
    : formatConsistencyReport(report);

  return { report, output };
}
