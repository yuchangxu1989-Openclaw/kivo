/**
 * Consistency Types — FR-Z09 文档与实现一致性门禁
 */

export interface ConsistencyIssue {
  /** Unique issue identifier */
  id: string;
  /** Severity: error blocks CI, warning is advisory */
  severity: 'error' | 'warning';
  /** Category of inconsistency */
  category: 'contradiction' | 'stale-reference' | 'missing-source' | 'semantic-drift';
  /** Entry ID of the first conflicting entry */
  entryIdA: string;
  /** Entry title A (for display) */
  titleA: string;
  /** Entry ID of the second conflicting entry (if applicable) */
  entryIdB?: string;
  /** Entry title B (for display) */
  titleB?: string;
  /** Human-readable description of the inconsistency */
  description: string;
  /** Similarity score that triggered the check (if applicable) */
  similarityScore?: number;
}

export interface ConsistencyReport {
  /** Timestamp of the check */
  checkedAt: Date;
  /** Total entries scanned */
  totalEntries: number;
  /** Total pairs compared */
  pairsCompared: number;
  /** Issues found */
  issues: ConsistencyIssue[];
  /** Whether the gate passed (no errors) */
  passed: boolean;
  /** Summary counts */
  summary: {
    errors: number;
    warnings: number;
  };
}

export interface ConsistencyCheckOptions {
  /** Similarity threshold for flagging potential contradictions (default 0.6) */
  similarityThreshold?: number;
  /** Only check entries of these types */
  types?: string[];
  /** Only check entries in these domains */
  domains?: string[];
  /** Treat warnings as errors (strict mode) */
  strict?: boolean;
}
