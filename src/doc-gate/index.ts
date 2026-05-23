export type {
  ReferenceKind,
  DocReference,
  Mismatch,
  ScanResult,
  DocGateOptions,
} from './types.js';
export { scanMarkdownFile, scanDocsDir } from './doc-scanner.js';
export { verifyDocCodeConsistency } from './code-verifier.js';
export { formatReport, hasFailures } from './reporter.js';
export { runDocGate } from './doc-gate-runner.js';
