/**
 * Capability Registry — 宿主能力协商 + Provider 管理
 * FR-I01, FR-I02
 */

export type HostCapabilityName = 'llm' | 'network' | 'file-read' | 'file-write' | 'tool-exec';
export type ProviderCapability = 'text-generation' | 'embedding' | 'structured-output';
export type ProviderSelectionStrategy = 'priority' | 'round-robin';

export interface HostCapabilityDeclaration {
  name: HostCapabilityName;
  version: string;
  contract: string;
  available: boolean;
  metadata?: Record<string, unknown>;
}

export interface HostCapabilityChangeEvent {
  capability: HostCapabilityDeclaration;
  changedAt: Date;
}

export interface RegisteredProvider {
  id: string;
  capabilities: ProviderCapability[];
  priority?: number;
  available: boolean;
  metadata?: Record<string, unknown>;
}

export interface CapabilityRegistryOptions {
  selectionStrategy?: ProviderSelectionStrategy;
}

export class CapabilityRegistry {
  private readonly capabilities = new Map<HostCapabilityName, HostCapabilityDeclaration>();
  private readonly providers = new Map<string, RegisteredProvider>();
  private readonly listeners = new Set<(event: HostCapabilityChangeEvent) => void | Promise<void>>();
  private selectionCursor = 0;
  private selectionStrategy: ProviderSelectionStrategy;

  constructor(options: CapabilityRegistryOptions = {}) {
    this.selectionStrategy = options.selectionStrategy ?? 'priority';
  }

  registerHostCapabilities(capabilities: HostCapabilityDeclaration[]): void {
    for (const capability of capabilities) {
      this.capabilities.set(capability.name, cloneCapability(capability));
      void this.emitCapabilityChange(capability);
    }
  }

  listCapabilities(): HostCapabilityDeclaration[] {
    return Array.from(this.capabilities.values()).map(cloneCapability);
  }

  getCapability(name: HostCapabilityName): HostCapabilityDeclaration | null {
    const capability = this.capabilities.get(name);
    return capability ? cloneCapability(capability) : null;
  }

  async updateCapability(name: HostCapabilityName, patch: Partial<HostCapabilityDeclaration>): Promise<void> {
    const existing = this.capabilities.get(name);
    if (!existing) throw new Error(`Capability not registered: ${name}`);

    const next: HostCapabilityDeclaration = {
      ...existing,
      ...patch,
      name: existing.name,
      metadata: patch.metadata ? { ...patch.metadata } : existing.metadata ? { ...existing.metadata } : undefined,
    };
    this.capabilities.set(name, next);
    await this.emitCapabilityChange(next);
  }

  onCapabilityChange(handler: (event: HostCapabilityChangeEvent) => void | Promise<void>): void {
    this.listeners.add(handler);
  }

  offCapabilityChange(handler: (event: HostCapabilityChangeEvent) => void | Promise<void>): void {
    this.listeners.delete(handler);
  }

  registerProvider(provider: RegisteredProvider): void {
    this.providers.set(provider.id, cloneProvider(provider));
  }

  updateProviderAvailability(providerId: string, available: boolean): void {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Provider not registered: ${providerId}`);
    this.providers.set(providerId, {
      ...provider,
      available,
    });
  }

  listProviders(): RegisteredProvider[] {
    return Array.from(this.providers.values()).map(cloneProvider);
  }

  selectProvider(capability: ProviderCapability): RegisteredProvider | null {
    const candidates = this.listProviders()
      .filter(provider => provider.available && provider.capabilities.includes(capability));

    if (candidates.length === 0) return null;

    if (this.selectionStrategy === 'round-robin') {
      const provider = candidates[this.selectionCursor % candidates.length];
      this.selectionCursor += 1;
      return provider;
    }

    candidates.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return candidates[0];
  }

  resolveActivatedDomains(): {
    dictionary: boolean;
    pipeline: boolean;
    artifactReview: boolean;
    conflictDetection: 'full' | 'degraded';
  } {
    const hasFileRead = this.capabilities.get('file-read')?.available ?? false;
    const hasFileWrite = this.capabilities.get('file-write')?.available ?? false;
    const hasToolExec = this.capabilities.get('tool-exec')?.available ?? false;
    const llmProvider = this.selectProvider('text-generation');
    const structuredProvider = this.selectProvider('structured-output');

    return {
      dictionary: hasFileRead,
      pipeline: hasFileRead && hasFileWrite,
      artifactReview: hasFileWrite || hasToolExec,
      conflictDetection: llmProvider || structuredProvider ? 'full' : 'degraded',
    };
  }

  private async emitCapabilityChange(capability: HostCapabilityDeclaration): Promise<void> {
    const event: HostCapabilityChangeEvent = {
      capability: cloneCapability(capability),
      changedAt: new Date(),
    };

    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}

function cloneCapability(capability: HostCapabilityDeclaration): HostCapabilityDeclaration {
  return {
    ...capability,
    metadata: capability.metadata ? { ...capability.metadata } : undefined,
  };
}

function cloneProvider(provider: RegisteredProvider): RegisteredProvider {
  return {
    ...provider,
    capabilities: [...provider.capabilities],
    metadata: provider.metadata ? { ...provider.metadata } : undefined,
  };
}
