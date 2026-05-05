/**
 * Tests for Domain I: Host Adapter
 * FR-I01, FR-I02
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CapabilityRegistry } from '../src/adapter/capability-registry.js';
import type {
  HostCapabilityDeclaration,
  RegisteredProvider,
  HostCapabilityChangeEvent,
} from '../src/adapter/capability-registry.js';
import {
  LLMProviderManager,
  ProviderUnavailableError,
} from '../src/adapter/llm-provider-manager.js';

// ── FR-I01: Host Capability Negotiation & Registration ──

describe('FR-I01: Host Capability Negotiation & Registration', () => {
  let registry: CapabilityRegistry;

  beforeEach(() => {
    registry = new CapabilityRegistry();
  });

  it('AC1: host declares capabilities, KIVO resolves activated domains', () => {
    registry.registerHostCapabilities([
      { name: 'llm', version: '1.0.0', contract: 'prompt->completion', available: true },
      { name: 'file-read', version: '1.0.0', contract: 'fs-read', available: true },
      { name: 'file-write', version: '1.0.0', contract: 'fs-write', available: true },
    ]);
    registry.registerProvider({
      id: 'openai',
      capabilities: ['text-generation'],
      priority: 10,
      available: true,
    });

    const domains = registry.resolveActivatedDomains();
    expect(domains.dictionary).toBe(true);
    expect(domains.pipeline).toBe(true);
    expect(domains.conflictDetection).toBe('full');
  });

  it('AC1: missing capabilities deactivate domains', () => {
    registry.registerHostCapabilities([
      { name: 'llm', version: '1.0.0', contract: 'prompt->completion', available: false },
      { name: 'file-read', version: '1.0.0', contract: 'fs-read', available: false },
      { name: 'file-write', version: '1.0.0', contract: 'fs-write', available: false },
    ]);

    const domains = registry.resolveActivatedDomains();
    expect(domains.dictionary).toBe(false);
    expect(domains.pipeline).toBe(false);
    expect(domains.conflictDetection).toBe('degraded');
  });

  it('AC2: capability declaration includes name, version, contract', () => {
    const cap: HostCapabilityDeclaration = {
      name: 'llm',
      version: '2.0.0',
      contract: 'chat-completion',
      available: true,
      metadata: { model: 'gpt-4' },
    };
    registry.registerHostCapabilities([cap]);

    const retrieved = registry.getCapability('llm');
    expect(retrieved).toBeTruthy();
    expect(retrieved!.name).toBe('llm');
    expect(retrieved!.version).toBe('2.0.0');
    expect(retrieved!.contract).toBe('chat-completion');
  });

  it('AC3: capability change notification', async () => {
    registry.registerHostCapabilities([
      { name: 'llm', version: '1.0.0', contract: 'prompt->completion', available: true },
    ]);

    const events: HostCapabilityChangeEvent[] = [];
    registry.onCapabilityChange(event => { events.push(event); });

    await registry.updateCapability('llm', { available: false });

    expect(events).toHaveLength(1);
    expect(events[0].capability.name).toBe('llm');
    expect(events[0].capability.available).toBe(false);
    expect(events[0].changedAt).toBeInstanceOf(Date);
  });

  it('AC3: degradation on capability loss', async () => {
    registry.registerHostCapabilities([
      { name: 'file-read', version: '1.0.0', contract: 'fs-read', available: true },
      { name: 'file-write', version: '1.0.0', contract: 'fs-write', available: true },
    ]);

    expect(registry.resolveActivatedDomains().pipeline).toBe(true);

    await registry.updateCapability('file-write', { available: false });
    expect(registry.resolveActivatedDomains().pipeline).toBe(false);
  });

  it('AC4: generic adapter interface — new host only implements interface', () => {
    // The KivoHostAdapter interface is generic; this test verifies
    // that CapabilityRegistry works independently of any specific adapter
    const reg1 = new CapabilityRegistry();
    reg1.registerHostCapabilities([
      { name: 'file-read', version: '1.0.0', contract: 'memory-read', available: true },
    ]);

    const reg2 = new CapabilityRegistry();
    reg2.registerHostCapabilities([
      { name: 'file-read', version: '1.0.0', contract: 'workspace-read', available: true },
    ]);

    // Both registries work identically despite different contracts
    expect(reg1.getCapability('file-read')!.contract).toBe('memory-read');
    expect(reg2.getCapability('file-read')!.contract).toBe('workspace-read');
  });

  it('removes capability change listener', async () => {
    registry.registerHostCapabilities([
      { name: 'llm', version: '1.0.0', contract: 'prompt->completion', available: true },
    ]);

    let callCount = 0;
    const handler = () => { callCount++; };
    registry.onCapabilityChange(handler);
    await registry.updateCapability('llm', { available: false });
    expect(callCount).toBe(1);

    registry.offCapabilityChange(handler);
    await registry.updateCapability('llm', { available: true });
    expect(callCount).toBe(1); // not called again
  });
});

// ── FR-I02: LLM Provider Management ──

describe('FR-I02: LLM Provider Management', () => {
  let registry: CapabilityRegistry;

  beforeEach(() => {
    registry = new CapabilityRegistry();
  });

  it('AC1: registers multiple providers with capabilities', () => {
    registry.registerProvider({
      id: 'openai',
      capabilities: ['text-generation', 'embedding'],
      priority: 10,
      available: true,
    });
    registry.registerProvider({
      id: 'anthropic',
      capabilities: ['text-generation', 'structured-output'],
      priority: 5,
      available: true,
    });

    const providers = registry.listProviders();
    expect(providers).toHaveLength(2);
    expect(providers.find(p => p.id === 'openai')!.capabilities).toContain('embedding');
    expect(providers.find(p => p.id === 'anthropic')!.capabilities).toContain('structured-output');
  });

  it('AC2: selects provider by capability with priority strategy', () => {
    registry.registerProvider({
      id: 'openai',
      capabilities: ['text-generation'],
      priority: 10,
      available: true,
    });
    registry.registerProvider({
      id: 'anthropic',
      capabilities: ['text-generation'],
      priority: 5,
      available: true,
    });

    const selected = registry.selectProvider('text-generation');
    expect(selected!.id).toBe('openai'); // higher priority
  });

  it('AC2: selects provider with round-robin strategy', () => {
    const rrRegistry = new CapabilityRegistry({ selectionStrategy: 'round-robin' });
    rrRegistry.registerProvider({
      id: 'a',
      capabilities: ['text-generation'],
      available: true,
    });
    rrRegistry.registerProvider({
      id: 'b',
      capabilities: ['text-generation'],
      available: true,
    });

    const first = rrRegistry.selectProvider('text-generation');
    const second = rrRegistry.selectProvider('text-generation');
    expect(first!.id).not.toBe(second!.id);
  });

  it('AC3: falls back to next provider when current unavailable', () => {
    registry.registerProvider({
      id: 'primary',
      capabilities: ['text-generation'],
      priority: 10,
      available: false, // unavailable
    });
    registry.registerProvider({
      id: 'fallback',
      capabilities: ['text-generation'],
      priority: 5,
      available: true,
    });

    const selected = registry.selectProvider('text-generation');
    expect(selected!.id).toBe('fallback');
  });

  it('AC3: returns null when no providers available', () => {
    registry.registerProvider({
      id: 'only',
      capabilities: ['text-generation'],
      priority: 10,
      available: false,
    });

    const selected = registry.selectProvider('text-generation');
    expect(selected).toBeNull();
  });

  it('AC3: degraded conflict detection when no LLM provider', () => {
    registry.registerHostCapabilities([
      { name: 'file-read', version: '1.0.0', contract: 'fs-read', available: true },
    ]);
    // No providers registered
    const domains = registry.resolveActivatedDomains();
    expect(domains.conflictDetection).toBe('degraded');
  });
});

// ── FR-I02 AC3: LLMProviderManager auto-failover ──

describe('FR-I02 AC3: LLMProviderManager auto-failover', () => {
  let registry: CapabilityRegistry;
  let manager: LLMProviderManager;

  beforeEach(() => {
    registry = new CapabilityRegistry();
    registry.registerProvider({
      id: 'primary',
      capabilities: ['text-generation'],
      priority: 10,
      available: true,
    });
    registry.registerProvider({
      id: 'fallback',
      capabilities: ['text-generation'],
      priority: 5,
      available: true,
    });
    manager = new LLMProviderManager({ registry, cooldownMs: 100 });
  });

  it('selects highest priority provider normally', () => {
    const provider = manager.selectProvider('text-generation');
    expect(provider!.id).toBe('primary');
  });

  it('auto-failover on provider failure', async () => {
    let callCount = 0;
    const result = await manager.executeWithFailover('text-generation', async (provider) => {
      callCount++;
      if (provider.id === 'primary') throw new Error('Primary down');
      return `result from ${provider.id}`;
    });

    expect(result).toBe('result from fallback');
    expect(callCount).toBe(2);
  });

  it('marks failed provider as unavailable', async () => {
    await manager.executeWithFailover('text-generation', async (provider) => {
      if (provider.id === 'primary') throw new Error('Primary down');
      return 'ok';
    });

    // Primary should now be unavailable
    const selected = manager.selectProvider('text-generation');
    expect(selected!.id).toBe('fallback');
  });

  it('throws ProviderUnavailableError when all providers fail', async () => {
    await expect(
      manager.executeWithFailover('text-generation', async () => {
        throw new Error('All down');
      }),
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it('reports degradation level', async () => {
    expect(manager.getDegradationLevel('text-generation')).toBe('normal');

    // Fail primary
    await manager.executeWithFailover('text-generation', async (provider) => {
      if (provider.id === 'primary') throw new Error('down');
      return 'ok';
    });

    expect(manager.getDegradationLevel('text-generation')).toBe('degraded');
  });

  it('restores provider after cooldown', async () => {
    // Fail primary
    await manager.executeWithFailover('text-generation', async (provider) => {
      if (provider.id === 'primary') throw new Error('down');
      return 'ok';
    });

    expect(manager.getDegradationLevel('text-generation')).toBe('degraded');

    // Wait for cooldown
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(manager.getDegradationLevel('text-generation')).toBe('normal');
    const selected = manager.selectProvider('text-generation');
    expect(selected!.id).toBe('primary');
  });

  it('manual restore provider', async () => {
    await manager.executeWithFailover('text-generation', async (provider) => {
      if (provider.id === 'primary') throw new Error('down');
      return 'ok';
    });

    manager.restoreProvider('primary');
    expect(manager.getDegradationLevel('text-generation')).toBe('normal');
  });

  it('resetAll clears all failures', async () => {
    await expect(
      manager.executeWithFailover('text-generation', async () => {
        throw new Error('down');
      }),
    ).rejects.toThrow();

    expect(manager.getDegradationLevel('text-generation')).toBe('unavailable');

    manager.resetAll();
    expect(manager.getDegradationLevel('text-generation')).toBe('normal');
  });

  it('getFailureRecords returns failure history', async () => {
    await manager.executeWithFailover('text-generation', async (provider) => {
      if (provider.id === 'primary') throw new Error('timeout');
      return 'ok';
    });

    const records = manager.getFailureRecords();
    expect(records).toHaveLength(1);
    expect(records[0].providerId).toBe('primary');
    expect(records[0].error).toBe('timeout');
  });
});
