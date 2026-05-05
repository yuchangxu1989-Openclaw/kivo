import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../src/rules/index.js';
import { MemoryKnowledgeStore } from '../src/storage/index.js';
import type { RuleEntry } from '../src/extraction/index.js';
import type { KnowledgeSource } from '../src/types/index.js';

const baseSource: KnowledgeSource = {
  type: 'system',
  reference: 'test://rules',
  timestamp: new Date('2026-04-20T00:00:00.000Z'),
  agent: 'dev-01',
};

function makeRule(overrides: Partial<RuleEntry> = {}): RuleEntry {
  const id = overrides.id ?? `rule-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = overrides.createdAt ?? new Date('2026-04-20T10:00:00.000Z');
  const updatedAt = overrides.updatedAt ?? new Date(createdAt.getTime());

  return {
    id,
    scene: 'dispatch',
    directive: `directive-${id}`,
    priority: 'medium',
    source: overrides.source ?? baseSource,
    confidence: 0.9,
    tags: ['governance'],
    createdAt,
    updatedAt,
    ...overrides,
  };
}

describe('RuleRegistry', () => {
  it('registers rules and queries by scene / priority / status', async () => {
    const store = new MemoryKnowledgeStore();
    const registry = new RuleRegistry(store);

    const enabled = await registry.register(
      makeRule({ id: 'rule-1', scene: 'dispatch', priority: 'high', directive: '必须先校验 agentId。' })
    );
    const disabled = await registry.register({
      ...makeRule({ id: 'rule-2', scene: 'dispatch', priority: 'low', directive: '可选记录调试日志。' }),
      enabled: false,
      registeredAt: new Date('2026-04-20T10:30:00.000Z'),
    });
    await registry.register(
      makeRule({ id: 'rule-3', scene: 'memory', priority: 'critical', directive: '禁止把记忆当结论。' })
    );

    expect(enabled.enabled).toBe(true);
    expect(disabled.enabled).toBe(false);

    const dispatchRules = await registry.query({ scene: 'dispatch' });
    expect(dispatchRules.map((rule) => rule.id)).toEqual(['rule-1', 'rule-2']);

    const enabledRules = await registry.query({ status: 'enabled' });
    expect(enabledRules.map((rule) => rule.id)).toEqual(['rule-3', 'rule-1']);

    const highPriority = await registry.query({ priority: ['high', 'critical'] });
    expect(highPriority.map((rule) => rule.id)).toEqual(['rule-3', 'rule-1']);
  });

  it('supports enable/disable and get by id', async () => {
    const store = new MemoryKnowledgeStore();
    const registry = new RuleRegistry(store);

    await registry.register({
      ...makeRule({ id: 'rule-toggle', scene: 'doctor', priority: 'critical', directive: '禁止执行 doctor --fix。' }),
      enabled: false,
    });

    const disabled = await registry.get('rule-toggle');
    expect(disabled?.enabled).toBe(false);

    const enabled = await registry.enable('rule-toggle');
    expect(enabled?.enabled).toBe(true);

    const reloaded = await registry.get('rule-toggle');
    expect(reloaded?.enabled).toBe(true);

    const disabledAgain = await registry.disable('rule-toggle');
    expect(disabledAgain?.enabled).toBe(false);

    expect(await registry.enable('missing')).toBeNull();
  });

  it('lists enabled scene rules sorted by priority then registration time', async () => {
    const store = new MemoryKnowledgeStore();
    const registry = new RuleRegistry(store);

    await registry.register({
      ...makeRule({
        id: 'rule-low',
        scene: 'review',
        priority: 'low',
        directive: '建议补充背景说明。',
      }),
      registeredAt: new Date('2026-04-20T10:05:00.000Z'),
    });
    await registry.register({
      ...makeRule({
        id: 'rule-critical',
        scene: 'review',
        priority: 'critical',
        directive: '禁止跳过事实查证。',
      }),
      registeredAt: new Date('2026-04-20T10:20:00.000Z'),
    });
    await registry.register({
      ...makeRule({
        id: 'rule-high-early',
        scene: 'review',
        priority: 'high',
        directive: '必须附证据。',
      }),
      registeredAt: new Date('2026-04-20T10:00:00.000Z'),
    });
    await registry.register({
      ...makeRule({
        id: 'rule-high-late',
        scene: 'review',
        priority: 'high',
        directive: '必须标注来源。',
      }),
      registeredAt: new Date('2026-04-20T10:15:00.000Z'),
      enabled: false,
    });

    const active = await registry.listByScene('review');
    expect(active.map((rule) => rule.id)).toEqual(['rule-critical', 'rule-high-early', 'rule-low']);
  });

  it('filters rules by agent scope', async () => {
    const store = new MemoryKnowledgeStore();
    const registry = new RuleRegistry(store);

    // Global rule (no agents — applies to all)
    await registry.register(
      makeRule({ id: 'rule-global', scene: 'dispatch', directive: '全局规则。' })
    );

    // Scoped to specific agents
    await registry.register({
      ...makeRule({ id: 'rule-sa', scene: 'dispatch', directive: '仅 sa-01 适用。' }),
      agents: ['sa-01'],
    });

    await registry.register({
      ...makeRule({ id: 'rule-multi', scene: 'dispatch', directive: '适用 dev-01 和 audit-01。' }),
      agents: ['dev-01', 'audit-01'],
    });

    // Query without agent filter — returns all
    const all = await registry.query({ scene: 'dispatch' });
    expect(all.map((r) => r.id)).toEqual(['rule-global', 'rule-sa', 'rule-multi']);

    // Query with agent filter — global rules always included, scoped rules filtered
    const forSa = await registry.query({ scene: 'dispatch', agent: 'sa-01' });
    expect(forSa.map((r) => r.id)).toEqual(['rule-global', 'rule-sa']);

    const forDev = await registry.query({ scene: 'dispatch', agent: 'dev-01' });
    expect(forDev.map((r) => r.id)).toEqual(['rule-global', 'rule-multi']);

    const forAudit = await registry.query({ scene: 'dispatch', agent: 'audit-01' });
    expect(forAudit.map((r) => r.id)).toEqual(['rule-global', 'rule-multi']);

    // Unknown agent — only global rules
    const forUnknown = await registry.query({ scene: 'dispatch', agent: 'unknown-agent' });
    expect(forUnknown.map((r) => r.id)).toEqual(['rule-global']);

    // Verify agents field round-trips correctly
    const sa = await registry.get('rule-sa');
    expect(sa?.agents).toEqual(['sa-01']);

    const global = await registry.get('rule-global');
    expect(global?.agents).toEqual([]);

    // Verify agent tags are stored but stripped from user-facing tags
    const stored = await store.get('rule-sa');
    expect(stored?.tags).toContain('agent:sa-01');
    expect(sa?.tags).not.toContain('agent:sa-01');
  });

  it('listByScene respects agent filter via query', async () => {
    const store = new MemoryKnowledgeStore();
    const registry = new RuleRegistry(store);

    await registry.register(
      makeRule({ id: 'rule-a', scene: 'review', priority: 'high', directive: '全局审查规则。' })
    );
    await registry.register({
      ...makeRule({ id: 'rule-b', scene: 'review', priority: 'critical', directive: '仅 audit-01。' }),
      agents: ['audit-01'],
    });

    // listByScene doesn't take agent param, but query does
    const allReview = await registry.listByScene('review');
    expect(allReview.map((r) => r.id)).toEqual(['rule-b', 'rule-a']);

    const forDev = await registry.query({ scene: 'review', status: 'enabled', agent: 'dev-01' });
    expect(forDev.map((r) => r.id)).toEqual(['rule-a']);
  });

  it('stores rule data via KnowledgeStore metadata and can be queried from the store', async () => {
    const store = new MemoryKnowledgeStore();
    const registry = new RuleRegistry(store);

    const registeredAt = new Date('2026-04-20T11:00:00.000Z');
    await registry.register({
      ...makeRule({
        id: 'rule-store',
        scene: 'openclaw.json',
        priority: 'critical',
        directive: '未经确认不得修改 openclaw.json。',
        tags: ['config', 'safety'],
      }),
      registeredAt,
    });

    const saved = await store.get('rule-store');
    expect(saved).not.toBeNull();
    expect(saved?.type).toBe('intent');
    expect(saved?.status).toBe('active');
    expect(saved?.tags).toContain('rule');
    expect(saved?.tags).toContain('scene:openclaw.json');
    expect(saved?.tags).toContain('priority:critical');
    expect(saved?.tags).toContain(`registered-at:${registeredAt.toISOString()}`);

    const queried = await store.query({ tags: ['rule', 'scene:openclaw.json'] });
    expect(queried.total).toBe(1);
    expect(queried.items[0]?.id).toBe('rule-store');

    const reloaded = await registry.get('rule-store');
    expect(reloaded).toMatchObject({
      id: 'rule-store',
      scene: 'openclaw.json',
      priority: 'critical',
      enabled: true,
    });
    expect(reloaded?.registeredAt.toISOString()).toBe(registeredAt.toISOString());
    expect(reloaded?.tags).toEqual(['config', 'safety']);
  });
});
