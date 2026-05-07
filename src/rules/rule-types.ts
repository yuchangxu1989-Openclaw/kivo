import type { RuleEntry, RulePriority } from '../extraction/rule-extractor.js';

export type RuleStatus = 'enabled' | 'disabled';

export interface RuleScopeCondition {
  field: 'role' | 'domain' | 'scene' | 'agent' | 'host';
  equals: string;
}

export interface RuleVersionRecord {
  version: number;
  directive: string;
  priority: RulePriority;
  tags: string[];
  enabled: boolean;
  updatedAt: Date;
  effectiveFrom?: Date;
  expiresAt?: Date;
  invalidationCondition?: string;
  overrides?: string[];
}

export interface RuleFilter {
  scene?: string | string[];
  priority?: RulePriority | RulePriority[];
  status?: RuleStatus | RuleStatus[];
  agent?: string;
}

export interface RegisteredRule extends RuleEntry {
  enabled: boolean;
  registeredAt: Date;
  agents: string[];
  version: number;
  effectiveFrom?: Date;
  expiresAt?: Date;
  invalidationCondition?: string;
  overrides: string[];
  scopeConditions: RuleScopeCondition[];
  versionHistory: RuleVersionRecord[];
  metadata?: Record<string, unknown>;
}

export type RuleRegistration = RuleEntry & Partial<Pick<RegisteredRule,
  | 'enabled'
  | 'registeredAt'
  | 'agents'
  | 'effectiveFrom'
  | 'expiresAt'
  | 'invalidationCondition'
  | 'overrides'
  | 'scopeConditions'
>>;
