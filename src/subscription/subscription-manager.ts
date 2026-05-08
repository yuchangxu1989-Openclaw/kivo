import { randomUUID } from 'node:crypto';
import type {
  NotificationResult,
  RegisteredSubscription,
  Subscription,
  SubscriptionEvent,
  SubscriptionManagerOptions,
  SubscriptionRuleContext,
  SubscriptionRuleFilter,
} from './subscription-types.js';

export class SubscriptionManager {
  private readonly subscriptions = new Map<string, RegisteredSubscription>();
  private readonly idFactory: () => string;
  private readonly resolveRuleContext?: SubscriptionManagerOptions['resolveRuleContext'];

  constructor(options: SubscriptionManagerOptions = {}) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.resolveRuleContext = options.resolveRuleContext;
  }

  subscribe(subscription: Subscription): string {
    const subscriptionId = this.idFactory();
    const normalized = normalizeSubscription(subscriptionId, subscription);
    this.subscriptions.set(subscriptionId, normalized);
    return subscriptionId;
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  async notify(event: SubscriptionEvent): Promise<NotificationResult> {
    const ruleContext = await this.resolveContext(event);
    const candidates = Array.from(this.subscriptions.values()).filter((subscription) =>
      matchesSubscription(subscription.ruleFilter, ruleContext)
    );

    const settled = await Promise.allSettled(
      candidates.map(async (subscription) => {
        await subscription.callback(event, cloneRuleContext(ruleContext));
        return subscription;
      })
    );

    const notifiedSubscriptionIds: string[] = [];
    const failures: NotificationResult['failures'] = [];

    settled.forEach((result, index) => {
      const subscription = candidates[index];
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
      event: cloneEvent(event),
      notifiedSubscriptionIds,
      failures,
    };
  }

  getSubscriptions(subscriberId?: string): RegisteredSubscription[] {
    return Array.from(this.subscriptions.values())
      .filter((subscription) => subscriberId === undefined || subscription.subscriberId === subscriberId)
      .map(cloneSubscription)
      .sort(compareSubscriptions);
  }

  private async resolveContext(event: SubscriptionEvent): Promise<SubscriptionRuleContext | null> {
    if (!this.resolveRuleContext) {
      return null;
    }

    const context = await this.resolveRuleContext(cloneEvent(event));
    return cloneRuleContext(context);
  }
}

function normalizeSubscription(id: string, subscription: Subscription): RegisteredSubscription {
  return {
    id,
    subscriberId: subscription.subscriberId.trim(),
    ruleFilter: normalizeFilter(subscription.ruleFilter),
    callback: subscription.callback,
  };
}

function normalizeFilter(filter?: SubscriptionRuleFilter): SubscriptionRuleFilter {
  return {
    scene: normalizeOptionalArray(filter?.scene),
    type: normalizeOptionalArray(filter?.type),
    tags: uniqueStrings(filter?.tags),
    role: normalizeOptionalArray(filter?.role),
    domain: normalizeOptionalArray(filter?.domain),
  };
}

function normalizeOptionalArray(value?: string | string[]): string | string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = uniqueStrings(Array.isArray(value) ? value : [value]);
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.length === 1 ? normalized[0] : normalized;
}

function matchesSubscription(
  filter: SubscriptionRuleFilter,
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

function uniqueStrings(values?: string[]): string[] {
  if (!values) {
    return [];
  }

  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

function cloneSubscription(subscription: RegisteredSubscription): RegisteredSubscription {
  return {
    ...subscription,
    ruleFilter: {
      scene: cloneFilterValue(subscription.ruleFilter.scene),
      type: cloneFilterValue(subscription.ruleFilter.type),
      tags: [...(subscription.ruleFilter.tags ?? [])],
      role: cloneFilterValue(subscription.ruleFilter.role),
      domain: cloneFilterValue(subscription.ruleFilter.domain),
    },
  };
}

function cloneFilterValue(value?: string | string[]): string | string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? [...value] : value;
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

function cloneEvent(event: SubscriptionEvent): SubscriptionEvent {
  return {
    ...event,
    timestamp: new Date(event.timestamp),
  };
}

function compareSubscriptions(a: RegisteredSubscription, b: RegisteredSubscription): number {
  const subscriberDiff = a.subscriberId.localeCompare(b.subscriberId);
  if (subscriberDiff !== 0) {
    return subscriberDiff;
  }
  return a.id.localeCompare(b.id);
}
