import type { DocGateOptions, ScanResult } from './types.js';
import { verifyDocCodeConsistency } from './code-verifier.js';
import { formatReport, hasFailures } from './reporter.js';

export interface DocGateResult {
  passed: boolean;
  exitCode: 0 | 1;
  report: string;
  scanResult: ScanResult;
}

export function runDocGate(options: DocGateOptions): DocGateResult {
  const scanResult = verifyDocCodeConsistency(options);
  const report = formatReport(scanResult);
  const passed = !hasFailures(scanResult, options.strict);
  return { passed, exitCode: passed ? 0 : 1, report, scanResult };
}

/**
 * CI/build friendly entrypoint.
 * Returns process exit code instead of exiting, so tests and callers can reuse it.
 */
export function run(options: DocGateOptions): number {
  return runDocGate(options).exitCode;
}
