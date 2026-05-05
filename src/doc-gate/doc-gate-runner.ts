import type { DocGateOptions, ScanResult } from './types.js';
import { verifyDocCodeConsistency } from './code-verifier.js';
import { formatReport, hasFailures } from './reporter.js';

export interface DocGateResult {
  passed: boolean;
  report: string;
  scanResult: ScanResult;
}

export function runDocGate(options: DocGateOptions): DocGateResult {
  const scanResult = verifyDocCodeConsistency(options);
  const report = formatReport(scanResult);
  const passed = !hasFailures(scanResult, options.strict);
  return { passed, report, scanResult };
}
