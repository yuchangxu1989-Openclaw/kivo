import type { KnowledgeEntry, KnowledgeSource } from '../types/index.js';
import type { KnowledgeStore } from '../storage/knowledge-store.js';
import type { RuleEntry } from '../extraction/rule-extractor.js';
import type {
  RegisteredRule,
  RuleFilter,
  RuleRegistration,
  RuleScopeCondition,
  RuleStatus,
  RuleVersionRecord,
} from './rule-types.js';

const RULE_TAG = 'rule';
const RULE_TAG_PREFIX = 'rule:';
const SCENE_TAG_PREFIX = 'scene:';
const STATUS_TAG_PREFIX = 'rule-status:';
const PRIORITY_TAG_PREFIX = 'priority:';
const REGISTERED_AT_PREFIX = 'registered-at:';
const AGENT_TAG_PREFIX = 'agent:';
const VERSION_PREFIX = 'rule-version:';
const EFFECTIVE_FROM_PREFIX = 'effective-from:';
const EXPIRES_AT_PREFIX = 'expires-at:';
const INVALIDATION_PREFIX = 'invalidation:';
const OVERRIDES_PREFIX = 'overrides:';
const SCOPE_PREFIX = 'scope:';
const DEFAULT_LIMIT = Number.MAX_SAFE_INTEGER;
const RULE_VERSION_HISTORY_KEY = 'ruleVersionHistory';

export class RuleRegistry {
  constructor(private readonly store: KnowledgeStore) {}

  async register(rule: RuleRegistration): Promise<RegisteredRule> {
    const current = await this.get(rule.id);
    const normalized = normalizeRegisteredRule(rule, current);
    const saved = await this.store.save(toKnowledgeEntry(normalized));
    return fromKnowledgeEntry(saved);
  }

  async get(id: string): Promise<RegisteredRule | null> {
    const entry = await this.store.get(id);
    if (!entry || !isRuleEntry(entry)) {
      return null;
    }
    return fromKnowledgeEntry(entry);
  }

  async query(filter: RuleFilter = {}): Promise<RegisteredRule[]> {
    const baseFilter = buildKnowledgeFilter(filter);
    const response = await this.store.query(baseFilter, { limit: DEFAULT_LIMIT });

    return response.items
      .filter(isRuleEntry)
      .map(fromKnowledgeEntry)
      .filter((rule) => matchesRuleFilter(rule, filter))
      .sort(compareRules);
  }

  async enable(id: string): Promise<RegisteredRule | null> {
    return this.setEnabled(id, true);
  }

  async disable(id: string): Promise<RegisteredRule | null> {
    return this.setEnabled(id, false);
  }

  async remove(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async listByScene(scene: string): Promise<RegisteredRule[]> {
    const rules = await this.query({ scene, status: 'enabled' });
    return rules.sort(compareRules);
  }

  private async setEnabled(id: string, enabled: boolean): Promise<RegisteredRule | null> {
    const current = await this.get(id);
    if (!current) {
      return null;
    }

    const nextVersion = current.version + 1;
    const nextHistory = appendVersionHistory(current.versionHistory, {
      version: nextVersion,
      directive: current.directive,
      priority: current.priority,
      tags: current.tags,
      enabled,
      updatedAt: new Date(),
      effectiveFrom: current.effectiveFrom,
      expiresAt: current.expiresAt,
      invalidationCondition: current.invalidationCondition,
      overrides: current.overrides,
    });

    const updated = await this.store.update(id, {
      title: current.scene,
      content: current.directive,
      summary: current.directive,
      confidence: current.confidence,
      status: enabled ? 'active' : 'pending',
      source: current.source,
      tags: buildRuleTags({
        scene: current.scene,
        priority: current.priority,
        enabled,
        registeredAt: current.registeredAt,
        tags: current.tags,
        agents: current.agents,
        version: nextVersion,
        effectiveFrom: current.effectiveFrom,
        expiresAt: current.expiresAt,
        invalidationCondition: current.invalidationCondition,
        overrides: current.overrides,
        scopeConditions: current.scopeConditions,
      }),
      metadata: {
        ...(current.metadata ?? {}),
        domainData: {
          ...((current.metadata as Record<string, unknown>)?.domainData as Record<string, unknown> ?? {}),
          [RULE_VERSION_HISTORY_KEY]: serializeVersionHistory(nextHistory),
        },
      },
      updatedAt: new Date(),
    });

    return updated && isRuleEntry(updated) ? fromKnowledgeEntry(updated) : null;
  }
}

function normalizeRegisteredRule(rule: RuleRegistration, current?: RegisteredRule | null): RegisteredRule {
  const enabled = rule.enabled ?? current?.enabled ?? true;
  const version = current ? current.version + 1 : 1;
  const effectiveFrom = toOptionalDate(rule.effectiveFrom ?? current?.effectiveFrom);
  const expiresAt = toOptionalDate(rule.expiresAt ?? current?.expiresAt);
  const invalidationCondition = normalizeOptionalString(
    rule.invalidationCondition ?? current?.invalidationCondition
  );
  const overrides = uniqueStrings(rule.overrides ?? current?.overrides ?? []);
  const scopeConditions = normalizeScopeConditions(rule.scopeConditions ?? current?.scopeConditions ?? []);
  const registeredAt = rule.registeredAt ? new Date(rule.registeredAt) : current?.registeredAt ?? new Date();
  const updatedAt = new Date(rule.updatedAt);

  const nextVersionRecord: RuleVersionRecord = {
    version,
    directive: rule.directive.trim(),
    priority: rule.priority,
    tags: [...rule.tags],
    enabled,
    updatedAt,
    effectiveFrom,
    expiresAt,
    invalidationCondition,
    overrides,
  };

  return {
    ...rule,
    scene: rule.scene.trim(),
    directive: rule.directive.trim(),
    enabled,
    registeredAt,
    source: cloneSource(rule.source),
    tags: [...rule.tags],
    agents: rule.agents ? [...rule.agents] : current?.agents ? [...current.agents] : [],
    createdAt: new Date(rule.createdAt),
    updatedAt,
    version,
    effectiveFrom,
    expiresAt,
    invalidationCondition,
    overrides,
    scopeConditions,
    versionHistory: appendVersionHistory(current?.versionHistory ?? [], nextVersionRecord),
  };
}

function toKnowledgeEntry(rule: RegisteredRule): KnowledgeEntry {
  return {
    id: rule.id,
    type: 'intent',
    title: rule.scene,
    content: rule.directive,
    summary: rule.directive,
    source: cloneSource(rule.source),
    confidence: rule.confidence,
    status: rule.enabled ? 'active' : 'pending',
    tags: buildRuleTags({
      scene: rule.scene,
      priority: rule.priority,
      enabled: rule.enabled,
      registeredAt: rule.registeredAt,
      tags: rule.tags,
      agents: rule.agents,
      version: rule.version,
      effectiveFrom: rule.effectiveFrom,
      expiresAt: rule.expiresAt,
      invalidationCondition: rule.invalidationCondition,
      overrides: rule.overrides,
      scopeConditions: rule.scopeConditions,
    }),
    createdAt: new Date(rule.createdAt),
    updatedAt: new Date(rule.updatedAt),
    version: 1,
    metadata: {
      domainData: {
        ruleVersion: rule.version,
        ruleEffectiveFrom: rule.effectiveFrom,
        ruleExpiresAt: rule.expiresAt,
        ruleInvalidationCondition: rule.invalidationCondition,
        ruleOverrides: [...rule.overrides],
        ruleScopeConditions: rule.scopeConditions.map((item) => ({ ...item })),
        [RULE_VERSION_HISTORY_KEY]: serializeVersionHistory(rule.versionHistory),
      },
    },
  };
}

function fromKnowledgeEntry(entry: KnowledgeEntry): RegisteredRule {
  const scene = findTagValue(entry.tags, SCENE_TAG_PREFIX) ?? entry.title;
  const priority = (findTagValue(entry.tags, PRIORITY_TAG_PREFIX) as RuleEntry['priority'] | undefined) ?? 'medium';
  const registeredAt = parseDateTag(entry.tags, REGISTERED_AT_PREFIX) ?? entry.createdAt;
  const enabled = deriveStatus(entry.status, entry.tags) === 'enabled';
  const agents = extractAgentTags(entry.tags);
  const version = parseIntegerTag(entry.tags, VERSION_PREFIX) ?? readMetadataVersion(entry.metadata) ?? 1;
  const effectiveFrom = parseDateTag(entry.tags, EFFECTIVE_FROM_PREFIX) ?? readMetadataDate(entry.metadata, 'ruleEffectiveFrom');
  const expiresAt = parseDateTag(entry.tags, EXPIRES_AT_PREFIX) ?? readMetadataDate(entry.metadata, 'ruleExpiresAt');
  const invalidationCondition =
    findTagValue(entry.tags, INVALIDATION_PREFIX) ?? readMetadataString(entry.metadata, 'ruleInvalidationCondition');
  const overrides = extractPrefixedValues(entry.tags, OVERRIDES_PREFIX) ?? readMetadataStringArray(entry.metadata, 'ruleOverrides');
  const scopeConditions = extractScopeConditions(entry.tags, entry.metadata);
  const versionHistory = readVersionHistory(entry.metadata, {
    version,
    directive: entry.content,
    priority,
    tags: stripMetaTags(entry.tags),
    enabled,
    updatedAt: entry.updatedAt,
    effectiveFrom,
    expiresAt,
    invalidationCondition,
    overrides,
  });

  return {
    id: entry.id,
    scene,
    directive: entry.content,
    priority,
    source: cloneSource(entry.source),
    confidence: entry.confidence,
    tags: stripMetaTags(entry.tags),
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
    enabled,
    registeredAt: new Date(registeredAt),
    agents,
    version,
    effectiveFrom,
    expiresAt,
    invalidationCondition,
    overrides,
    scopeConditions,
    versionHistory,
  };
}

function buildKnowledgeFilter(filter: RuleFilter) {
  const tags = [RULE_TAG];

  const priorities = normalizeArray(filter.priority);
  if (priorities && priorities.length === 1) {
    tags.push(`${PRIORITY_TAG_PREFIX}${priorities[0]}`);
  }

  const statuses = normalizeArray(filter.status);
  if (statuses && statuses.length === 1) {
    tags.push(`${STATUS_TAG_PREFIX}${statuses[0]}`);
  }

  const scenes = normalizeArray(filter.scene);
  if (scenes && scenes.length === 1) {
    tags.push(`${SCENE_TAG_PREFIX}${scenes[0]}`);
  }

  return {
    type: 'intent' as const,
    tags,
  };
}

function matchesRuleFilter(rule: RegisteredRule, filter: RuleFilter): boolean {
  const scenes = normalizeArray(filter.scene);
  if (scenes && !scenes.includes(rule.scene)) {
    return false;
  }

  const priorities = normalizeArray(filter.priority);
  if (priorities && !priorities.includes(rule.priority)) {
    return false;
  }

  const statuses = normalizeArray(filter.status);
  if (statuses && !statuses.includes(rule.enabled ? 'enabled' : 'disabled')) {
    return false;
  }

  if (filter.agent && rule.agents.length > 0 && !rule.agents.includes(filter.agent)) {
    return false;
  }

  return true;
}

function compareRules(a: RegisteredRule, b: RegisteredRule): number {
  const priorityDiff = priorityWeight(b.priority) - priorityWeight(a.priority);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  return a.registeredAt.getTime() - b.registeredAt.getTime();
}

function priorityWeight(priority: RuleEntry['priority']): number {
  switch (priority) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
  }
}

function buildRuleTags(input: {
  scene: string;
  priority: RuleEntry['priority'];
  enabled: boolean;
  registeredAt: Date;
  tags: string[];
  agents: string[];
  version: number;
  effectiveFrom?: Date;
  expiresAt?: Date;
  invalidationCondition?: string;
  overrides: string[];
  scopeConditions: RuleScopeCondition[];
}): string[] {
  return unique([
    RULE_TAG,
    `${RULE_TAG_PREFIX}registered`,
    `${SCENE_TAG_PREFIX}${input.scene}`,
    `${PRIORITY_TAG_PREFIX}${input.priority}`,
    `${STATUS_TAG_PREFIX}${input.enabled ? 'enabled' : 'disabled'}`,
    `${REGISTERED_AT_PREFIX}${input.registeredAt.toISOString()}`,
    `${VERSION_PREFIX}${input.version}`,
    ...(input.effectiveFrom ? [`${EFFECTIVE_FROM_PREFIX}${input.effectiveFrom.toISOString()}`] : []),
    ...(input.expiresAt ? [`${EXPIRES_AT_PREFIX}${input.expiresAt.toISOString()}`] : []),
    ...(input.invalidationCondition ? [`${INVALIDATION_PREFIX}${encodeTagValue(input.invalidationCondition)}`] : []),
    ...input.overrides.map((value) => `${OVERRIDES_PREFIX}${encodeTagValue(value)}`),
    ...input.scopeConditions.map((condition) => `${SCOPE_PREFIX}${condition.field}=${encodeTagValue(condition.equals)}`),
    ...input.agents.map((a) => `${AGENT_TAG_PREFIX}${a}`),
    ...input.tags,
  ]);
}

function stripMetaTags(tags: string[]): string[] {
  return tags.filter(
    (tag) =>
      tag !== RULE_TAG &&
      tag !== `${RULE_TAG_PREFIX}registered` &&
      !tag.startsWith(SCENE_TAG_PREFIX) &&
      !tag.startsWith(PRIORITY_TAG_PREFIX) &&
      !tag.startsWith(STATUS_TAG_PREFIX) &&
      !tag.startsWith(REGISTERED_AT_PREFIX) &&
      !tag.startsWith(AGENT_TAG_PREFIX) &&
      !tag.startsWith(VERSION_PREFIX) &&
      !tag.startsWith(EFFECTIVE_FROM_PREFIX) &&
      !tag.startsWith(EXPIRES_AT_PREFIX) &&
      !tag.startsWith(INVALIDATION_PREFIX) &&
      !tag.startsWith(OVERRIDES_PREFIX) &&
      !tag.startsWith(SCOPE_PREFIX)
  );
}

function extractAgentTags(tags: string[]): string[] {
  return tags
    .filter((tag) => tag.startsWith(AGENT_TAG_PREFIX))
    .map((tag) => tag.slice(AGENT_TAG_PREFIX.length));
}

function deriveStatus(status: KnowledgeEntry['status'], tags: string[]): RuleStatus {
  const tagStatus = findTagValue(tags, STATUS_TAG_PREFIX);
  if (tagStatus === 'enabled' || tagStatus === 'disabled') {
    return tagStatus;
  }
  return status === 'active' ? 'enabled' : 'disabled';
}

function parseDateTag(tags: string[], prefix: string): Date | null {
  const value = findTagValue(tags, prefix);
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseIntegerTag(tags: string[], prefix: string): number | null {
  const value = findTagValue(tags, prefix);
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function findTagValue(tags: string[], prefix: string): string | null {
  const tag = tags.find((candidate) => candidate.startsWith(prefix));
  return tag ? decodeTagValue(tag.slice(prefix.length)) : null;
}

function extractPrefixedValues(tags: string[], prefix: string): string[] {
  return tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => decodeTagValue(tag.slice(prefix.length)));
}

function extractScopeConditions(
  tags: string[],
  metadata: KnowledgeEntry['metadata']
): RuleScopeCondition[] {
  const fromTags = tags
    .filter((tag) => tag.startsWith(SCOPE_PREFIX))
    .map((tag) => decodeTagValue(tag.slice(SCOPE_PREFIX.length)))
    .map(parseScopeCondition)
    .filter((value): value is RuleScopeCondition => value !== null);

  if (fromTags.length > 0) {
    return fromTags;
  }

  const domainData = metadata?.domainData as Record<string, unknown> | undefined;
  const raw = domainData && 'ruleScopeConditions' in domainData ? domainData.ruleScopeConditions : undefined;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const field = typeof item.field === 'string' ? item.field : '';
      const equals = typeof item.equals === 'string' ? item.equals.trim() : '';
      if (!isScopeField(field) || !equals) {
        return null;
      }
      return { field, equals } satisfies RuleScopeCondition;
    })
    .filter((item): item is RuleScopeCondition => item !== null);
}

function parseScopeCondition(raw: string): RuleScopeCondition | null {
  const [field, value] = raw.split('=');
  if (!isScopeField(field) || !value) {
    return null;
  }
  return {
    field,
    equals: value.trim(),
  };
}

function isScopeField(value: string): value is RuleScopeCondition['field'] {
  return ['role', 'domain', 'scene', 'agent', 'host'].includes(value);
}

function normalizeArray<T>(value?: T | T[]): T[] | null {
  if (value === undefined) {
    return null;
  }
  return Array.isArray(value) ? value : [value];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueStrings(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean).filter((value, index, array) => array.indexOf(value) === index);
}

function isRuleEntry(entry: KnowledgeEntry): boolean {
  return entry.type === 'intent' && entry.tags.includes(RULE_TAG);
}

function cloneSource(source: KnowledgeSource): KnowledgeSource {
  return {
    ...source,
    timestamp: new Date(source.timestamp),
  };
}

function toOptionalDate(value: Date | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function encodeTagValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeTagValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeScopeConditions(conditions: RuleScopeCondition[]): RuleScopeCondition[] {
  const seen = new Set<string>();
  const normalized: RuleScopeCondition[] = [];

  for (const condition of conditions) {
    const field = condition.field;
    const equals = condition.equals.trim();
    if (!equals) {
      continue;
    }

    const key = `${field}:${equals}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({ field, equals });
  }

  return normalized;
}

function appendVersionHistory(
  current: RuleVersionRecord[],
  next: RuleVersionRecord
): RuleVersionRecord[] {
  const filtered = current.filter((item) => item.version !== next.version);
  filtered.push(cloneVersionRecord(next));
  return filtered.sort((a, b) => a.version - b.version);
}

function serializeVersionHistory(history: RuleVersionRecord[]): Array<Record<string, unknown>> {
  return history.map((item) => ({
    version: item.version,
    directive: item.directive,
    priority: item.priority,
    tags: [...item.tags],
    enabled: item.enabled,
    updatedAt: item.updatedAt.toISOString(),
    effectiveFrom: item.effectiveFrom?.toISOString(),
    expiresAt: item.expiresAt?.toISOString(),
    invalidationCondition: item.invalidationCondition,
    overrides: [...(item.overrides ?? [])],
  }));
}

function readVersionHistory(
  metadata: KnowledgeEntry['metadata'],
  fallback: Omit<RuleVersionRecord, 'version'> & { version: number }
): RuleVersionRecord[] {
  const domainData = metadata?.domainData as Record<string, unknown> | undefined;
  const raw = domainData && RULE_VERSION_HISTORY_KEY in domainData
    ? domainData[RULE_VERSION_HISTORY_KEY]
    : undefined;

  if (!Array.isArray(raw) || raw.length === 0) {
    return [cloneVersionRecord(fallback)];
  }

  const history = raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const version = typeof item.version === 'number' ? Math.floor(item.version) : 0;
      const directive = typeof item.directive === 'string' ? item.directive.trim() : '';
      const priority = isPriority(item.priority) ? item.priority : fallback.priority;
      const tags = Array.isArray(item.tags) ? item.tags.map((value) => String(value).trim()).filter(Boolean) : [];
      const enabled = typeof item.enabled === 'boolean' ? item.enabled : fallback.enabled;
      const updatedAt = item.updatedAt ? new Date(String(item.updatedAt)) : new Date(fallback.updatedAt);
      const effectiveFrom = item.effectiveFrom ? new Date(String(item.effectiveFrom)) : fallback.effectiveFrom;
      const expiresAt = item.expiresAt ? new Date(String(item.expiresAt)) : fallback.expiresAt;
      const invalidationCondition = typeof item.invalidationCondition === 'string'
        ? item.invalidationCondition.trim()
        : fallback.invalidationCondition;
      const overrides = Array.isArray(item.overrides)
        ? item.overrides.map((value) => String(value).trim()).filter(Boolean)
        : [...(fallback.overrides ?? [])];

      if (!version || !directive) {
        return null;
      }

      return {
        version,
        directive,
        priority,
        tags,
        enabled,
        updatedAt,
        effectiveFrom,
        expiresAt,
        invalidationCondition,
        overrides,
      } as RuleVersionRecord;
    })
    .filter((item): item is RuleVersionRecord => item !== null);

  return history.length > 0 ? history : [cloneVersionRecord(fallback)];
}

function cloneVersionRecord(record: RuleVersionRecord): RuleVersionRecord {
  return {
    ...record,
    tags: [...record.tags],
    updatedAt: new Date(record.updatedAt),
    effectiveFrom: record.effectiveFrom ? new Date(record.effectiveFrom) : undefined,
    expiresAt: record.expiresAt ? new Date(record.expiresAt) : undefined,
    overrides: [...(record.overrides ?? [])],
  };
}

function readMetadataVersion(metadata: KnowledgeEntry['metadata']): number | undefined {
  const domainData = metadata?.domainData as Record<string, unknown> | undefined;
  const value = domainData && 'ruleVersion' in domainData ? domainData.ruleVersion : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function readMetadataDate(metadata: KnowledgeEntry['metadata'], key: string): Date | undefined {
  const domainData = metadata?.domainData as Record<string, unknown> | undefined;
  const value = domainData && key in domainData ? domainData[key] : undefined;
  if (value instanceof Date) {
    return new Date(value);
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function readMetadataString(metadata: KnowledgeEntry['metadata'], key: string): string | undefined {
  const domainData = metadata?.domainData as Record<string, unknown> | undefined;
  const value = domainData && key in domainData ? domainData[key] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readMetadataStringArray(metadata: KnowledgeEntry['metadata'], key: string): string[] {
  const domainData = metadata?.domainData as Record<string, unknown> | undefined;
  const value = domainData && key in domainData ? domainData[key] : undefined;
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

function isPriority(value: unknown): value is RuleEntry['priority'] {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}
