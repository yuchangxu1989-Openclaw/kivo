export { ExpiryDetector } from './expiry-detector.js';
export { CleanupManager } from './cleanup-manager.js';
export { KnowledgeMerger } from './knowledge-merger.js';
export type {
  CleanupEntry,
  CleanupReport,
  ExpiredEntry,
  ExpiryPolicy,
  ExpiryReason,
} from './lifecycle-types.js';
export type {
  MergeCandidate,
  MergeError,
  MergeHistory,
  MergedEntry,
  MergeResult,
  MergeReversal,
  SourceRef,
} from './knowledge-merge-types.js';
