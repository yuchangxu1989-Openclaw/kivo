import { describe, expect, it, vi } from 'vitest';
import { RuleDistributor } from '../src/distribution/index.js';
import { RuleRegistry } from '../src/rules/index.js';
import { MemoryKnowledgeStore } from '../src/storage/index.js';
import { SubscriptionManager } from '../src/subscription/index.js';
import type { RuleEntry } from '../src/extraction/index.js';
import type { SubscriptionEvent, SubscriptionEventType } from '../src/subscription/index.js';
import type { KnowledgeSource } from '../src/types/index.js';

const baseSource: KnowledgeSource = {
  type: 'system',
  reference: 'test://distribution',
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
    priority: 'high',
    source: overrides.source ?? baseSource,
    confidence: 0.9,
    tags: ['ops'],
    createdAt,
    updatedAt,
    ...overrides,
  };
}

async function setupRuleRegistry(ruleOverrides: Partial<RuleEntry> = {}) {
  const store = new MemoryKnowledgeStore();
  const registry = new RuleRegistry(store);
  const rule = await registry.register(makeRule({ id: 'rule-1', ...ruleOverrides }));
  return { store, registry, rule };
}

function createNowSequence(...timestamps: string[]): () => Date {
  let index = 0;
  return () => new Date(timestamps[index++] ?? timestamps[timestamps.length - 1] ?? '2026-04-20T12:00:00.000Z');
}

function sequenceIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `sub-${index}`;
}

function makeEvent(overrides: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  return {
    type: 'rule-updated',
    ruleId: 'rule-1',
    timestamp: new Date('2026-04-20T12:00:00.000Z'),
    ...overrides,
  };
}

describe('RuleDistributor', () => {
  it('triggers distribution on rule change events', async () => {
    const { registry } = await setupRuleRegistry({ scene: 'dispatch', priority: 'critical', tags: ['ops', 'urgent'] });
    const manager = new SubscriptionManager({ idFactory: sequenceIds('sub-1', 'sub-2') });
    const dispatchCallback = vi.fn();
    const memoryCallback = vi.fn();

    manager.subscribe({
      subscriberId: 'agent-dispatch',
      ruleFilter: { scene: 'dispatch', tags: ['urgent'] },
      callback: dispatchCallback,
    });
    manager.subscribe({
      subscriberId: 'agent-memory',
      ruleFilter: { scene: 'memory' },
      callback: memoryCallback,
    });

    const distributor = new RuleDistributor({
      ruleRegistry: registry,
      subscriptionManager: manager,
      now: createNowSequence('2026-04-20T12:00:30.000Z'),
    });

    const result = await distributor.onRuleChange(makeEvent({ type: 'rule-enabled' }));

    expect(dispatchCallback).toHaveBeenCalledTimes(1);
    expect(dispatchCallback).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'rule-1', type: 'rule-enabled' }),
      expect.objectContaining({ scene: 'dispatch', type: 'critical', tags: ['ops', 'urgent'] })
    );
    expect(memoryCallback).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ruleId: 'rule-1',
      subscriberCount: 1,
      successCount: 1,
      failureCount: 0,
      timestamp: new Date('2026-04-20T12:00:30.000Z'),
    });
  });

  it('records distribution results and exposes history by rule', async () => {
    const { registry } = await setupRuleRegistry();
    const manager = new SubscriptionManager({ idFactory: sequenceIds('sub-1') });
    manager.subscribe({
      subscriberId: 'agent-a',
      ruleFilter: { scene: 'dispatch' },
      callback: vi.fn(),
    });

    const distributor = new RuleDistributor({
      ruleRegistry: registry,
      subscriptionManager: manager,
      now: createNowSequence('2026-04-20T12:01:00.000Z', '2026-04-20T12:02:00.000Z'),
    });

    const first = await distributor.distribute('rule-1', 'rule-added');
    const second = await distributor.distribute('rule-1', 'rule-updated');

    expect(first.timestamp.toISOString()).toBe('2026-04-20T12:01:00.000Z');
    expect(second.timestamp.toISOString()).toBe('2026-04-20T12:02:00.000Z');

    const fullHistory = distributor.getDistributionHistory();
    const perRuleHistory = distributor.getDistributionHistory('rule-1');

    expect(fullHistory).toHaveLength(2);
    expect(perRuleHistory).toHaveLength(2);
    expect(perRuleHistory).toEqual(fullHistory);
    expect(distributor.getDistributionHistory('missing-rule')).toEqual([]);
  });

  it('retries failed deliveries until success', async () => {
    const { registry } = await setupRuleRegistry({ priority: 'high', tags: ['ops'] });
    const manager = new SubscriptionManager({ idFactory: sequenceIds('sub-1') });
    const callback = vi
      .fn<[(SubscriptionEvent), { scene?: string; type?: string; tags?: string[] } | null], Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce();
    const sleep = vi.fn().mockResolvedValue(undefined);

    manager.subscribe({
      subscriberId: 'agent-a',
      ruleFilter: { scene: 'dispatch' },
      callback,
    });

    const distributor = new RuleDistributor({
      ruleRegistry: registry,
      subscriptionManager: manager,
      config: { maxRetries: 2, retryDelayMs: 15, batchSize: 1 },
      now: createNowSequence('2026-04-20T12:03:00.000Z'),
      sleep,
    });

    const result = await distributor.distribute('rule-1', 'rule-updated');

    expect(callback).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(15);
    expect(result).toMatchObject({
      ruleId: 'rule-1',
      subscriberCount: 1,
      successCount: 1,
      failureCount: 0,
      timestamp: new Date('2026-04-20T12:03:00.000Z'),
    });
  });

  it('keeps failed deliveries in history after retry exhaustion', async () => {
    const { registry } = await setupRuleRegistry();
    const manager = new SubscriptionManager({ idFactory: sequenceIds('sub-1') });
    const callback = vi.fn().mockRejectedValue(new Error('permanent failure'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    manager.subscribe({
      subscriberId: 'agent-a',
      ruleFilter: { scene: 'dispatch' },
      callback,
    });

    const distributor = new RuleDistributor({
      ruleRegistry: registry,
      subscriptionManager: manager,
      config: { maxRetries: 2, retryDelayMs: 10, batchSize: 1 },
      now: createNowSequence('2026-04-20T12:04:00.000Z'),
      sleep,
    });

    const result = await distributor.distribute('rule-1', 'rule-disabled');

    expect(callback).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ruleId: 'rule-1',
      subscriberCount: 1,
      successCount: 0,
      failureCount: 1,
      timestamp: new Date('2026-04-20T12:04:00.000Z'),
    });
    const history = distributor.getDistributionHistory('rule-1');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      ruleId: 'rule-1',
      subscriberCount: 1,
      successCount: 0,
      failureCount: 1,
    });
  });

  it('retries failed deliveries in batches', async () => {
    const { registry } = await setupRuleRegistry({ tags: ['ops', 'batch'] });
    const manager = new SubscriptionManager({ idFactory: sequenceIds('sub-1', 'sub-2', 'sub-3') });
    const callMoments: Array<{ subscriberId: string; step: number }> = [];
    let step = 0;

    const createCallback = (subscriberId: string) =>
      vi.fn(async () => {
        callMoments.push({ subscriberId, step: step++ });
        throw new Error(`failed-${subscriberId}`);
      });

    const callbackA = createCallback('agent-a');
    const callbackB = createCallback('agent-b');
    const callbackC = createCallback('agent-c');

    manager.subscribe({
      subscriberId: 'agent-a',
      ruleFilter: { scene: 'dispatch', tags: ['batch'] },
      callback: callbackA,
    });
    manager.subscribe({
      subscriberId: 'agent-b',
      ruleFilter: { scene: 'dispatch', tags: ['batch'] },
      callback: callbackB,
    });
    manager.subscribe({
      subscriberId: 'agent-c',
      ruleFilter: { scene: 'dispatch', tags: ['batch'] },
      callback: callbackC,
    });

    const sleep = vi.fn().mockResolvedValue(undefined);
    const distributor = new RuleDistributor({
      ruleRegistry: registry,
      subscriptionManager: manager,
      config: { maxRetries: 1, retryDelayMs: 0, batchSize: 2 },
      now: createNowSequence('2026-04-20T12:05:00.000Z'),
      sleep,
    });

    const result = await distributor.distribute('rule-1', 'rule-updated');

    expect(result).toMatchObject({
      ruleId: 'rule-1',
      subscriberCount: 3,
      successCount: 0,
      failureCount: 3,
      timestamp: new Date('2026-04-20T12:05:00.000Z'),
    });
    expect(callbackA).toHaveBeenCalledTimes(2);
    expect(callbackB).toHaveBeenCalledTimes(2);
    expect(callbackC).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();

    const retrySequence = callMoments.slice(3).map(({ subscriberId }) => subscriberId);
    expect(retrySequence).toEqual(['agent-a', 'agent-b', 'agent-c']);
  });
});
