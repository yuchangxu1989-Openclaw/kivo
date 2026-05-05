import type {
  NotificationFailure,
  RegisteredSubscription,
  SubscriptionEvent,
  SubscriptionEventType,
  SubscriptionRuleContext,
} from '../subscription/index.js';
import type {
  DistributionResult,
  RetryableFailure,
  RuleDistributionOptions,
  RuleDistributionRuleSnapshot,
  StoredDistributionRecord,
} from './distribution-types.js';
import { normalizeDistributionConfig } from './distribution-types.js';

export class RuleDistributor {
  private readonly ruleRegistry: RuleDistributionOptions['ruleRegistry'];
  private readonly subscriptionManager: RuleDistributionOptions['subscriptionManager'];
  private readonly config;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly history = new Map<string, StoredDistributionRecord[]>();

  constructor(options: RuleDistributionOptions) {
    this.ruleRegistry = options.ruleRegistry;
    this.subscriptionManager = options.subscriptionManager;
    this.config = normalizeDistributionConfig(options.config);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
  }

  async onRuleChange(event: SubscriptionEvent): Promise<DistributionResult> {
    return this.performDistribution(cloneEvent(event), this.now());
  }

  async distribute(ruleId: string, eventType: SubscriptionEventType): Promise<DistributionResult> {
    const timestamp = this.now();
    return this.performDistribution(
      {
        type: eventType,
        ruleId,
        timestamp,
      },
      timestamp
    );
  }

  getDistributionHistory(ruleId?: string): DistributionResult[] {
    const records = ruleId
      ? [...(this.history.get(ruleId) ?? [])]
      : Array.from(this.history.values()).flatMap((entries) => entries);

    return records
      .slice()
      .sort((a, b) => a.result.timestamp.getTime() - b.result.timestamp.getTime())
      .map((record) => cloneDistributionResult(record.result));
  }

  private async performDistribution(
    event: SubscriptionEvent,
    distributedAt: Date
  ): Promise<DistributionResult> {
    const initialResult = await this.subscriptionManager.notify(cloneEvent(event));
    const mergedResult = await this.notifyRemainingSubscribers(initialResult.event, initialResult);
    return this.finalizeDistribution(mergedResult.event, mergedResult, distributedAt);
  }

  private async finalizeDistribution(
    event: SubscriptionEvent,
    initialResult: Awaited<ReturnType<RuleDistributionOptions['subscriptionManager']['notify']>>,
    distributedAt: Date
  ): Promise<DistributionResult> {
    const successes = new Set(initialResult.notifiedSubscriptionIds);
    const involvedSubscribers = this.collectInvolvedSubscriptionIds(initialResult);
    const retryFailures = await this.retryFailures(event, initialResult.failures);
    const ruleSnapshot = await this.ruleRegistry.get(event.ruleId);

    retryFailures.resolvedSubscriptionIds.forEach((subscriptionId) => successes.add(subscriptionId));

    const unresolvedIds = uniqueStrings(retryFailures.remainingFailures.map((failure) => failure.subscriptionId));
    const result: DistributionResult = {
      ruleId: event.ruleId,
      subscriberCount: involvedSubscribers.length,
      successCount: successes.size,
      failureCount: unresolvedIds.length,
      timestamp: new Date(distributedAt),
      notifiedSubscriberIds: [...successes].sort(),
      failedSubscriberIds: [...unresolvedIds].sort(),
      acknowledgedSubscriberIds: [...successes].sort(),
      pendingSubscriberIds: [...unresolvedIds].sort(),
      highPriorityPush: ruleSnapshot?.priority === 'high' || ruleSnapshot?.priority === 'critical',
    };

    this.recordHistory({
      result,
      eventType: event.type,
      successSubscriptionIds: [...successes].sort(),
      failedSubscriptionIds: unresolvedIds,
      subscriberIds: involvedSubscribers,
      ruleVersion: ruleSnapshot?.version,
    });

    return cloneDistributionResult(result);
  }

  private async notifyRemainingSubscribers(
    event: SubscriptionEvent,
    initialResult: Awaited<ReturnType<RuleDistributionOptions['subscriptionManager']['notify']>>
  ): Promise<Awaited<ReturnType<RuleDistributionOptions['subscriptionManager']['notify']>>> {
    const attemptedIds = new Set([
      ...initialResult.notifiedSubscriptionIds,
      ...initialResult.failures.map((failure) => failure.subscriptionId),
    ]);
    const ruleContext = await this.resolveRuleContext(event.ruleId);
    const remainingSubscriptions = this.subscriptionManager
      .getSubscriptions()
      .filter(
        (subscription) => !attemptedIds.has(subscription.id) && matchesSubscription(subscription.ruleFilter, ruleContext)
      );

    if (remainingSubscriptions.length === 0) {
      return {
        event: cloneEvent(initialResult.event),
        notifiedSubscriptionIds: [...initialResult.notifiedSubscriptionIds],
        failures: initialResult.failures.map(cloneFailure),
      };
    }

    const settled = await Promise.allSettled(
      remainingSubscriptions.map(async (subscription) => {
        await subscription.callback(cloneEvent(event), cloneRuleContext(ruleContext));
        return subscription;
      })
    );

    const notifiedSubscriptionIds = [...initialResult.notifiedSubscriptionIds];
    const failures = initialResult.failures.map(cloneFailure);

    settled.forEach((result, index) => {
      const subscription = remainingSubscriptions[index];
      if (result.status === 'fulfilled') {
        notifiedSubscriptionIds.push(subscription.id);
        return;
      }

      failures.push({
        subscriptionId: subscription.id,
        subscriberId: subscription.subscriberId,
        error: result.reason,
      });
    });

    return {
      event: cloneEvent(initialResult.event),
      notifiedSubscriptionIds: uniqueStrings(notifiedSubscriptionIds).sort(),
      failures,
    };
  }

  private async retryFailures(
    event: SubscriptionEvent,
    failures: NotificationFailure[]
  ): Promise<{ resolvedSubscriptionIds: string[]; remainingFailures: RetryableFailure[] }> {
    if (failures.length === 0 || this.config.maxRetries === 0) {
      return {
        resolvedSubscriptionIds: [],
        remainingFailures: failures.map(cloneFailure),
      };
    }

    const retryableMap = new Map<string, RetryableFailure>();
    const subscriptionMap = new Map(
      this.subscriptionManager.getSubscriptions().map((subscription) => [subscription.id, subscription])
    );

    failures.forEach((failure) => {
      const subscription = subscriptionMap.get(failure.subscriptionId);
      retryableMap.set(failure.subscriptionId, {
        ...cloneFailure(failure),
        callback: subscription?.callback,
      });
    });

    let pendingFailures = Array.from(retryableMap.values());
    const resolvedSubscriptionIds = new Set<string>();
    const ruleContext = await this.resolveRuleContext(event.ruleId);

    for (let attempt = 1; attempt <= this.config.maxRetries && pendingFailures.length > 0; attempt += 1) {
      if (this.config.retryDelayMs > 0) {
        await this.sleep(this.config.retryDelayMs);
      }

      const nextFailures: RetryableFailure[] = [];
      const batches = chunk(pendingFailures, this.config.batchSize);

      for (const batch of batches) {
        const settled = await Promise.allSettled(
          batch.map(async (failure) => {
            if (!failure.callback) {
              throw failure.error;
            }

            await failure.callback(cloneEvent(event), cloneRuleContext(ruleContext));
            return failure.subscriptionId;
          })
        );

        settled.forEach((result, index) => {
          const failure = batch[index];
          if (result.status === 'fulfilled') {
            resolvedSubscriptionIds.add(result.value);
            return;
          }

          nextFailures.push({
            ...failure,
            error: result.reason,
          });
        });
      }

      pendingFailures = nextFailures;
    }

    return {
      resolvedSubscriptionIds: [...resolvedSubscriptionIds],
      remainingFailures: pendingFailures.map(cloneRetryableFailure),
    };
  }

  private async resolveRuleContext(ruleId: string): Promise<SubscriptionRuleContext | null> {
    const rule = await this.ruleRegistry.get(ruleId);
    if (!rule) {
      return null;
    }

    return toRuleContext(rule);
  }

  private collectInvolvedSubscriptionIds(initialResult: {
    notifiedSubscriptionIds: string[];
    failures: NotificationFailure[];
  }): string[] {
    return uniqueStrings([
      ...initialResult.notifiedSubscriptionIds,
      ...initialResult.failures.map((failure) => failure.subscriptionId),
    ]).sort();
  }

  private recordHistory(record: StoredDistributionRecord): void {
    const entries = this.history.get(record.result.ruleId) ?? [];
    entries.push(cloneStoredRecord(record));
    this.history.set(record.result.ruleId, entries);
  }
}

function toRuleContext(rule: Pick<RuleDistributionRuleSnapshot, 'scene' | 'priority' | 'tags'> & Partial<RuleDistributionRuleSnapshot>): SubscriptionRuleContext {
  return {
    scene: rule.scene,
    type: rule.priority,
    tags: [...rule.tags],
    role: rule.scopeConditions?.find((item) => item.field === 'role')?.equals,
    domain: rule.scopeConditions?.find((item) => item.field === 'domain')?.equals,
  };
}

function matchesSubscription(
  filter: RegisteredSubscription['ruleFilter'],
  ruleContext: SubscriptionRuleContext | null
): boolean {
  if (!filter.scene && !filter.type && !filter.role && !filter.domain && (!filter.tags || filter.tags.length === 0)) {
    return true;
  }

  if (!ruleContext) {
    return false;
  }

  if (!matchesScalarFilter(filter.scene, ruleContext.scene)) {
    return false;
  }

  if (!matchesScalarFilter(filter.type, ruleContext.type)) {
    return false;
  }

  if (!matchesScalarFilter(filter.role, ruleContext.role)) {
    return false;
  }

  if (!matchesScalarFilter(filter.domain, ruleContext.domain)) {
    return false;
  }

  if (filter.tags && filter.tags.length > 0) {
    const tagSet = new Set((ruleContext.tags ?? []).map((tag) => tag.trim()).filter(Boolean));
    if (!filter.tags.every((tag) => tagSet.has(tag))) {
      return false;
    }
  }

  return true;
}

function matchesScalarFilter(
  filterValue: string | string[] | undefined,
  actualValue: string | undefined
): boolean {
  if (filterValue === undefined) {
    return true;
  }

  if (!actualValue) {
    return false;
  }

  const allowed = Array.isArray(filterValue) ? filterValue : [filterValue];
  return allowed.includes(actualValue);
}

function chunk<T>(values: T[], size: number): T[][] {
  if (values.length === 0) {
    return [];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function cloneEvent(event: SubscriptionEvent): SubscriptionEvent {
  return {
    ...event,
    timestamp: new Date(event.timestamp),
  };
}

function cloneRuleContext(context: SubscriptionRuleContext | null): SubscriptionRuleContext | null {
  if (!context) {
    return null;
  }

  return {
    ...context,
    tags: context.tags ? [...context.tags] : undefined,
  };
}

function cloneDistributionResult(result: DistributionResult): DistributionResult {
  return {
    ...result,
    timestamp: new Date(result.timestamp),
  };
}

function cloneFailure(failure: NotificationFailure): NotificationFailure {
  return {
    ...failure,
  };
}

function cloneRetryableFailure(failure: RetryableFailure): RetryableFailure {
  return {
    ...cloneFailure(failure),
    callback: failure.callback,
  };
}

function cloneStoredRecord(record: StoredDistributionRecord): StoredDistributionRecord {
  return {
    ...record,
    result: cloneDistributionResult(record.result),
    successSubscriptionIds: [...record.successSubscriptionIds],
    failedSubscriptionIds: [...record.failedSubscriptionIds],
    subscriberIds: [...record.subscriberIds],
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
