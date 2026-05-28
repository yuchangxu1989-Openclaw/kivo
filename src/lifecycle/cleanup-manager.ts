import type { KnowledgeStore } from '../storage/knowledge-store.js';
import { ExpiryDetector } from './expiry-detector.js';
import type {
  CleanupEntry,
  CleanupReport,
  ExpiredEntry,
  ExpiryPolicy,
  ExpiryReason,
} from './lifecycle-types.js';

export interface CleanupManagerOptions {
  store: KnowledgeStore;
  detector?: ExpiryDetector;
  now?: () => Date;
}

export class CleanupManager {
  private readonly store: KnowledgeStore;
  private readonly detector: ExpiryDetector;
  private readonly now: () => Date;

  constructor(options: CleanupManagerOptions) {
    this.store = options.store;
    this.detector = options.detector ?? new ExpiryDetector({ now: options.now });
    this.now = options.now ?? (() => new Date());
  }

  async cleanup(policy: ExpiryPolicy): Promise<CleanupReport> {
    const cleanedAt = this.now();
    const result = await this.store.query();
    const entries = result.items;

    const expiredEntries = this.detector.detect(entries, policy);

    const reportEntries = toCleanupEntries(expiredEntries);

    return {
      entries: reportEntries,
      cleanedAt,
      summary: summarize(reportEntries),
    };
  }
}

function toCleanupEntries(
  expiredEntries: ExpiredEntry[],
): CleanupEntry[] {
  return expiredEntries.flatMap((expired) =>
    expired.reasons.map((reason) => ({
      knowledgeId: expired.entry.id,
      reason,
      previousStatus: expired.entry.status,
      action: 'removed' as const,
    }))
  );
}

function summarize(entries: CleanupEntry[]): CleanupReport['summary'] {
  const summary: CleanupReport['summary'] = {
    total: entries.length,
    removed: entries.length,
    reasons: {
      time_decay: 0,
      low_reference: 0,
      external_invalidation: 0,
    },
  };

  for (const entry of entries) {
    summary.reasons[entry.reason] += 1;
  }

  return summary;
}
