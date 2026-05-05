import type { KnowledgeEntry } from '../types/index.js';
import type { ExpiredEntry, ExpiryPolicy, ExpiryReason } from './lifecycle-types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class ExpiryDetector {
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  detect(entries: KnowledgeEntry[], policy: ExpiryPolicy): ExpiredEntry[] {
    const currentTime = this.now();

    return entries
      .filter((entry) => entry.status !== 'archived')
      .map((entry) => {
        const reasons = this.detectReasons(entry, policy, currentTime);
        if (reasons.length === 0) {
          return null;
        }

        return {
          entry,
          reasons,
          expiredAt: new Date(currentTime),
        } satisfies ExpiredEntry;
      })
      .filter((item): item is ExpiredEntry => item !== null);
  }

  private detectReasons(
    entry: KnowledgeEntry,
    policy: ExpiryPolicy,
    currentTime: Date
  ): ExpiryReason[] {
    const reasons: ExpiryReason[] = [];
    const metadata = entry.metadata;

    const lastActivity = entry.updatedAt.getTime();
    const ageDays = (currentTime.getTime() - lastActivity) / MS_PER_DAY;
    if (ageDays > policy.maxAgeDays) {
      reasons.push('time_decay');
    }

    const referenceCount = metadata?.referenceCount ?? 0;
    if (referenceCount < policy.minReferenceCount) {
      reasons.push('low_reference');
    }

    if (policy.externalValidation && metadata?.externalValid === false) {
      reasons.push('external_invalidation');
    }

    return reasons;
  }
}
