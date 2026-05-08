import type { RulePriority } from '../extraction/rule-extractor.js';
import type {
  NotificationFailure,
  NotificationResult,
  RegisteredSubscription,
  SubscriptionEvent,
} from '../subscription/index.js';

export interface DistributionResult {
  ruleId: string;
  subscriberCount: number;
  successCount: number;
  failureCount: number;
  timestamp: Date;
  notifiedSubscriberIds: string[];
  failedSubscriberIds: string[];
  acknowledgedSubscriberIds: string[];
  pendingSubscriberIds: string[];
  highPriorityPush: boolean;
}

export interface DistributionConfig {
  maxRetries?: number;
  retryDelayMs?: number;
  batchSize?: number;
}

export interface RuleLookup {
  get(id: string): Promise<{
    scene: string;
    priority: RulePriority;
    tags: string[];
    version: number;
    agents?: string[];
    scopeConditions?: Array<{ field: string; equals: string }>;
  } | null>;
}

export interface SubscriptionNotifier {
  notify(event: SubscriptionEvent): Promise<NotificationResult>;
  getSubscriptions(subscriberId?: string): RegisteredSubscription[];
}

export interface RuleDistributionDependencies {
  ruleRegistry: RuleLookup;
  subscriptionManager: SubscriptionNotifier;
}

export interface RuleDistributionOptions extends RuleDistributionDependencies {
  config?: DistributionConfig;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface ResolvedDistributionConfig {
  maxRetries: number;
  retryDelayMs: number;
  batchSize: number;
}

export interface RetryableFailure extends NotificationFailure {
  callback?: RegisteredSubscription['callback'];
}

export interface RuleDistributionAttempt {
  event: SubscriptionEvent;
  notificationResult: NotificationResult;
}

export interface RuleDistributionRuleSnapshot {
  id: string;
  scene: string;
  priority: RulePriority;
  tags: string[];
  version: number;
  agents?: string[];
  scopeConditions?: Array<{ field: string; equals: string }>;
}

export interface StoredDistributionRecord {
  result: DistributionResult;
  eventType: SubscriptionEvent['type'];
  successSubscriptionIds: string[];
  failedSubscriptionIds: string[];
  subscriberIds: string[];
  ruleVersion?: number;
}

export function normalizeDistributionConfig(
  config: DistributionConfig = {}
): ResolvedDistributionConfig {
  return {
    maxRetries: normalizeNonNegativeInteger(config.maxRetries),
    retryDelayMs: normalizeNonNegativeInteger(config.retryDelayMs),
    batchSize: Math.max(1, normalizeNonNegativeInteger(config.batchSize, Number.MAX_SAFE_INTEGER)),
  };
}

function normalizeNonNegativeInteger(value: number | undefined, fallback = 0): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.floor(value);
}
