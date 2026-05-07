/**
 * kivo deduplicate — CLI command for MECE knowledge governance (FR-N01)
 *
 * Subcommands:
 *   kivo deduplicate scan [--threshold 0.80] [--auto] [--domain <value>] [--json]
 *   kivo deduplicate coverage --domain <value> [--json]
 */

import {
  runDeduplicateScan,
  runCoverageAudit,
  formatDeduplicateReport,
  formatCoverageReport,
  type DeduplicateOptions,
} from './mece-governance.js';

export interface DeduplicateCmdOptions {
  threshold?: string;
  auto?: boolean;
  domain?: string;
  json?: boolean;
}

export async function runDeduplicateCmd(
  subCmd: string | undefined,
  options: DeduplicateCmdOptions,
): Promise<string> {
  switch (subCmd) {
    case 'scan':
    case undefined: {
      // Default to scan
      const scanOpts: DeduplicateOptions = {
        threshold: options.threshold ? parseFloat(options.threshold) : undefined,
        auto: !!options.auto,
        domain: options.domain,
      };

      try {
        const report = await runDeduplicateScan(scanOpts);

        if (options.json) {
          return JSON.stringify(report, null, 2);
        }

        return formatDeduplicateReport(report);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return options.json ? JSON.stringify({ error: msg }) : `✗ ${msg}`;
      }
    }

    case 'coverage': {
      if (!options.domain) {
        return options.json
          ? JSON.stringify({ error: 'Missing --domain parameter' })
          : '✗ 覆盖度审计需要指定 --domain 参数\n用法: kivo deduplicate coverage --domain <domain-id>';
      }

      try {
        const report = await runCoverageAudit({ domain: options.domain });

        if (options.json) {
          return JSON.stringify(report, null, 2);
        }

        return formatCoverageReport(report);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return options.json ? JSON.stringify({ error: msg }) : `✗ ${msg}`;
      }
    }

    default:
      return `kivo deduplicate — MECE 知识治理

用法:
  kivo deduplicate [scan]                全库语义去重扫描
  kivo deduplicate coverage --domain X   覆盖度审计

扫描选项:
  --threshold 0.80   相似度阈值（默认 0.80）
  --auto             自动合并相似度 > 0.95 的条目（可回退）
  --domain <value>   按域限定扫描范围
  --json             JSON 输出`;
  }
}
