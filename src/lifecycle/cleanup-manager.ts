import type { KnowledgeStore } from '../storage/knowledge-store.js';
import type { KnowledgeEntry } from '../types/index.js';
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

  async markDeprecated(entryIds: string[]): Promise<void> {
    const timestamp = this.now();
    const uniqueIds = dedupe(entryIds);

    for (const id of uniqueIds) {
      const entry = await this.store.get(id);
      if (!entry || entry.status === 'archived') {
        continue;
      }

      await this.store.update(id, {
        status: 'deprecated',
        updatedAt: timestamp,
        metadata: {
          ...(entry.metadata ?? {}),
          deprecatedAt: timestamp,
        },
      });
    }
  }

  async archive(entryIds: string[]): Promise<void> {
    const timestamp = this.now();
    const uniqueIds = dedupe(entryIds);

    for (const id of uniqueIds) {
      const entry = await this.store.get(id);
      if (!entry || entry.status !== 'deprecated') {
        continue;
      }

      await this.store.update(id, {
        status: 'archived',
        updatedAt: timestamp,
        metadata: {
          ...(entry.metadata ?? {}),
          archivedAt: timestamp,
        },
      });
    }
  }

  async cleanup(policy: ExpiryPolicy): Promise<CleanupReport> {
    const cleanedAt = this.now();
    const result = await this.store.query();
    const entries = result.items;

    const expiredEntries = this.detector.detect(entries, policy);
    const activeExpired = expiredEntries.filter((expired) => expired.entry.status !== 'deprecated');
    const deprecatedExpired = expiredEntries.filter((expired) => expired.entry.status === 'deprecated');

    await this.markDeprecated(activeExpired.map((expired) => expired.entry.id));
    await this.archive(
      deprecatedExpired
        .filter((expired) => hasCompletedCleanupCycle(expired.entry, cleanedAt, policy))
        .map((expired) => expired.entry.id)
    );

    const reportEntries = [
      ...toCleanupEntries(activeExpired, 'deprecated'),
      ...toCleanupEntries(
        deprecatedExpired.filter((expired) => hasCompletedCleanupCycle(expired.entry, cleanedAt, policy)),
        'archived'
      ),
    ];

    return {
      entries: reportEntries,
      cleanedAt,
      summary: summarize(reportEntries),
    };
  }
}

function hasCompletedCleanupCycle(
  entry: KnowledgeEntry,
  referenceTime: Date,
  policy: ExpiryPolicy
): boolean {
  const deprecatedAt = entry.metadata?.deprecatedAt;
  if (!deprecatedAt) {
    return true;
  }

  const elapsedMs = referenceTime.getTime() - deprecatedAt.getTime();
  return elapsedMs >= policy.maxAgeDays * 24 * 60 * 60 * 1000;
}

function toCleanupEntries(
  expiredEntries: ExpiredEntry[],
  action: CleanupEntry['action']
): CleanupEntry[] {
  return expiredEntries.flatMap((expired) =>
    expired.reasons.map((reason) => ({
      knowledgeId: expired.entry.id,
      reason,
      previousStatus: expired.entry.status,
      action,
    }))
  );
}

function summarize(entries: CleanupEntry[]): CleanupReport['summary'] {
  const summary: CleanupReport['summary'] = {
    total: entries.length,
    deprecated: 0,
    archived: 0,
    reasons: {
      time_decay: 0,
      low_reference: 0,
      external_invalidation: 0,
    },
  };

  for (const entry of entries) {
    summary[entry.action] += 1;
    summary.reasons[entry.reason] += 1;
  }

  return summary;
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}
