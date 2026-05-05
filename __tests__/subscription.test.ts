import { describe, expect, it, vi } from 'vitest';
import { SubscriptionManager } from '../src/subscription/index.js';
import type {
  SubscriptionEvent,
  SubscriptionRuleContext,
} from '../src/subscription/index.js';

function makeEvent(overrides: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  return {
    type: 'rule-updated',
    ruleId: 'rule-1',
    timestamp: new Date('2026-04-20T12:00:00.000Z'),
    ...overrides,
  };
}

describe('SubscriptionManager', () => {
  it('subscribes, lists, and unsubscribes subscriptions', () => {
    const manager = new SubscriptionManager({
      idFactory: sequenceIds('sub-1', 'sub-2'),
    });

    const firstId = manager.subscribe({
      subscriberId: 'agent-a',
      callback: vi.fn(),
    });
    const secondId = manager.subscribe({
      subscriberId: 'agent-a',
      ruleFilter: { scene: 'dispatch' },
      callback: vi.fn(),
    });

    expect(firstId).toBe('sub-1');
    expect(secondId).toBe('sub-2');
    expect(manager.getSubscriptions()).toHaveLength(2);
    expect(manager.getSubscriptions('agent-a').map((subscription) => subscription.id)).toEqual(['sub-1', 'sub-2']);

    expect(manager.unsubscribe(firstId)).toBe(true);
    expect(manager.unsubscribe(firstId)).toBe(false);
    expect(manager.getSubscriptions('agent-a').map((subscription) => subscription.id)).toEqual(['sub-2']);
  });

  it('notifies matching subscribers for generic events without rule context filter', async () => {
    const manager = new SubscriptionManager({
      idFactory: sequenceIds('sub-1', 'sub-2'),
    });
    const allEvents = vi.fn();
    const filtered = vi.fn();

    manager.subscribe({
      subscriberId: 'agent-a',
      callback: allEvents,
    });
    manager.subscribe({
      subscriberId: 'agent-b',
      ruleFilter: { scene: 'dispatch' },
      callback: filtered,
    });

    const result = await manager.notify(makeEvent({ type: 'rule-added' }));

    expect(allEvents).toHaveBeenCalledTimes(1);
    expect(allEvents).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'rule-1', type: 'rule-added' }),
      null
    );
    expect(filtered).not.toHaveBeenCalled();
    expect(result.notifiedSubscriptionIds).toEqual(['sub-1']);
    expect(result.failures).toEqual([]);
  });

  it('filters notifications by scene', async () => {
    const contexts = new Map<string, SubscriptionRuleContext>([
      ['rule-dispatch', { scene: 'dispatch', type: 'high', tags: ['ops', 'urgent'] }],
      ['rule-memory', { scene: 'memory', type: 'medium', tags: ['memory'] }],
    ]);
    const manager = new SubscriptionManager({
      idFactory: sequenceIds('sub-1', 'sub-2', 'sub-3'),
      resolveRuleContext: async (event) => contexts.get(event.ruleId) ?? null,
    });

    const dispatchOnly = vi.fn();
    const memoryOnly = vi.fn();
    const urgentDispatch = vi.fn();

    manager.subscribe({
      subscriberId: 'agent-dispatch',
      ruleFilter: { scene: 'dispatch' },
      callback: dispatchOnly,
    });
    manager.subscribe({
      subscriberId: 'agent-memory',
      ruleFilter: { scene: 'memory' },
      callback: memoryOnly,
    });
    manager.subscribe({
      subscriberId: 'agent-urgent',
      ruleFilter: { scene: 'dispatch', tags: ['urgent'] },
      callback: urgentDispatch,
    });

    const result = await manager.notify(makeEvent({ ruleId: 'rule-dispatch' }));

    expect(dispatchOnly).toHaveBeenCalledTimes(1);
    expect(memoryOnly).not.toHaveBeenCalled();
    expect(urgentDispatch).toHaveBeenCalledTimes(1);
    expect(result.notifiedSubscriptionIds).toEqual(['sub-1', 'sub-3']);
  });

  it('handles multiple subscribers concurrently and reports callback failures', async () => {
    const manager = new SubscriptionManager({
      idFactory: sequenceIds('sub-1', 'sub-2', 'sub-3'),
      resolveRuleContext: async () => ({ scene: 'dispatch', type: 'critical', tags: ['ops'] }),
    });
    const callOrder: string[] = [];

    manager.subscribe({
      subscriberId: 'agent-fast',
      ruleFilter: { scene: 'dispatch' },
      callback: async () => {
        await wait(5);
        callOrder.push('fast');
      },
    });
    manager.subscribe({
      subscriberId: 'agent-slow',
      ruleFilter: { scene: 'dispatch' },
      callback: async () => {
        await wait(20);
        callOrder.push('slow');
      },
    });
    manager.subscribe({
      subscriberId: 'agent-fail',
      ruleFilter: { scene: 'dispatch' },
      callback: async () => {
        await wait(1);
        throw new Error('push failed');
      },
    });

    const result = await manager.notify(makeEvent({ type: 'rule-enabled' }));

    expect(callOrder).toEqual(['fast', 'slow']);
    expect(result.notifiedSubscriptionIds).toEqual(['sub-1', 'sub-2']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      subscriptionId: 'sub-3',
      subscriberId: 'agent-fail',
    });
    expect(result.failures[0]?.error).toBeInstanceOf(Error);
  });

  it('does not notify after unsubscribe', async () => {
    const manager = new SubscriptionManager({
      idFactory: sequenceIds('sub-1'),
      resolveRuleContext: async () => ({ scene: 'dispatch', type: 'high', tags: ['ops'] }),
    });
    const callback = vi.fn();

    const subscriptionId = manager.subscribe({
      subscriberId: 'agent-a',
      ruleFilter: { scene: 'dispatch' },
      callback,
    });

    manager.unsubscribe(subscriptionId);
    const result = await manager.notify(makeEvent({ type: 'rule-disabled' }));

    expect(callback).not.toHaveBeenCalled();
    expect(result.notifiedSubscriptionIds).toEqual([]);
    expect(result.failures).toEqual([]);
  });
});

function sequenceIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `sub-${index}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
