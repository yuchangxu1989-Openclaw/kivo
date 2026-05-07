import type { RulePriority } from '../extraction/rule-extractor.js';

export type SubscriptionEventType =
  | 'rule-added'
  | 'rule-updated'
  | 'rule-enabled'
  | 'rule-disabled'
  | 'rule-removed';

export interface SubscriptionRuleFilter {
  scene?: string | string[];
  type?: RulePriority | RulePriority[] | string | string[];
  tags?: string[];
  role?: string | string[];
  domain?: string | string[];
}

export interface SubscriptionRuleContext {
  scene?: string;
  type?: string;
  tags?: string[];
  role?: string;
  domain?: string;
}

export interface SubscriptionEvent {
  type: SubscriptionEventType;
  ruleId: string;
  timestamp: Date;
}

export type SubscriptionCallback = (
  event: SubscriptionEvent,
  ruleContext: SubscriptionRuleContext | null
) => void | Promise<void>;

export interface Subscription {
  subscriberId: string;
  ruleFilter?: SubscriptionRuleFilter;
  callback: SubscriptionCallback;
}

export interface RegisteredSubscription extends Subscription {
  id: string;
  ruleFilter: SubscriptionRuleFilter;
}

export interface NotificationFailure {
  subscriptionId: string;
  subscriberId: string;
  error: unknown;
}

export interface NotificationResult {
  event: SubscriptionEvent;
  notifiedSubscriptionIds: string[];
  failures: NotificationFailure[];
}

export interface SubscriptionManagerOptions {
  idFactory?: () => string;
  resolveRuleContext?: (
    event: SubscriptionEvent
  ) => SubscriptionRuleContext | null | Promise<SubscriptionRuleContext | null>;
}
