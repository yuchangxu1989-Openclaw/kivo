/**
 * LLMProviderManager — 自动故障转移 + 降级状态管理
 * FR-I02 AC3
 *
 * 包装 CapabilityRegistry 的 Provider 选择，增加：
 * - 调用失败时自动标记不可用并切换到备选 Provider
 * - 无可用 Provider 时进入降级状态
 * - 冷却期后自动恢复 Provider 可用性
 */

import type { CapabilityRegistry, RegisteredProvider } from './capability-registry.js';
import type { ProviderCapability } from './capability-registry.js';

export type DegradationLevel = 'normal' | 'degraded' | 'unavailable';

export interface ProviderFailureRecord {
  providerId: string;
  failedAt: Date;
  error: string;
  cooldownUntil: Date;
}

export interface LLMProviderManagerOptions {
  registry: CapabilityRegistry;
  /** 冷却时间（毫秒），Provider 失败后多久自动恢复。默认 60_000 (1 min) */
  cooldownMs?: number;
  /** 连续失败多少次后标记不可用。默认 1 */
  maxConsecutiveFailures?: number;
}

export class LLMProviderManager {
  private readonly registry: CapabilityRegistry;
  private readonly cooldownMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly failures = new Map<string, ProviderFailureRecord>();
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(options: LLMProviderManagerOptions) {
    this.registry = options.registry;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 1;
  }

  /**
   * 获取当前降级状态
   */
  getDegradationLevel(capability: ProviderCapability): DegradationLevel {
    this.restoreCooledDownProviders();
    const available = this.registry.listProviders()
      .filter(p => p.available && p.capabilities.includes(capability));

    if (available.length === 0) return 'unavailable';

    const total = this.registry.listProviders()
      .filter(p => p.capabilities.includes(capability));

    if (available.length < total.length) return 'degraded';
    return 'normal';
  }

  /**
   * 选择可用 Provider，自动跳过冷却中的 Provider
   */
  selectProvider(capability: ProviderCapability): RegisteredProvider | null {
    this.restoreCooledDownProviders();
    return this.registry.selectProvider(capability);
  }

  /**
   * 执行带自动故障转移的 Provider 调用
   * 失败时自动切换到下一个可用 Provider 重试
   */
  async executeWithFailover<T>(
    capability: ProviderCapability,
    fn: (provider: RegisteredProvider) => Promise<T>,
  ): Promise<T> {
    this.restoreCooledDownProviders();

    const tried = new Set<string>();
    let lastError: Error | null = null;

    while (true) {
      const provider = this.findNextProvider(capability, tried);
      if (!provider) break;

      tried.add(provider.id);

      try {
        const result = await fn(provider);
        // 成功：重置连续失败计数
        this.consecutiveFailures.delete(provider.id);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.recordFailure(provider.id, lastError.message);
      }
    }

    throw new ProviderUnavailableError(
      capability,
      lastError?.message ?? 'No available providers',
    );
  }

  /**
   * 手动标记 Provider 恢复可用
   */
  restoreProvider(providerId: string): void {
    this.failures.delete(providerId);
    this.consecutiveFailures.delete(providerId);
    this.registry.updateProviderAvailability(providerId, true);
  }

  /**
   * 获取所有失败记录
   */
  getFailureRecords(): ProviderFailureRecord[] {
    return Array.from(this.failures.values());
  }

  /**
   * 清除所有失败记录并恢复所有 Provider
   */
  resetAll(): void {
    for (const [providerId] of this.failures) {
      try {
        this.registry.updateProviderAvailability(providerId, true);
      } catch {
        // provider may have been removed
      }
    }
    this.failures.clear();
    this.consecutiveFailures.clear();
  }

  private findNextProvider(capability: ProviderCapability, exclude: Set<string>): RegisteredProvider | null {
    const candidates = this.registry.listProviders()
      .filter(p => p.available && p.capabilities.includes(capability) && !exclude.has(p.id));

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return candidates[0];
  }

  private recordFailure(providerId: string, error: string): void {
    const count = (this.consecutiveFailures.get(providerId) ?? 0) + 1;
    this.consecutiveFailures.set(providerId, count);

    if (count >= this.maxConsecutiveFailures) {
      const now = new Date();
      this.failures.set(providerId, {
        providerId,
        failedAt: now,
        error,
        cooldownUntil: new Date(now.getTime() + this.cooldownMs),
      });
      this.registry.updateProviderAvailability(providerId, false);
    }
  }

  private restoreCooledDownProviders(): void {
    const now = Date.now();
    for (const [providerId, record] of this.failures) {
      if (record.cooldownUntil.getTime() <= now) {
        this.failures.delete(providerId);
        this.consecutiveFailures.delete(providerId);
        try {
          this.registry.updateProviderAvailability(providerId, true);
        } catch {
          // provider may have been removed
        }
      }
    }
  }
}

export class ProviderUnavailableError extends Error {
  readonly capability: ProviderCapability;

  constructor(capability: ProviderCapability, reason: string) {
    super(`No available provider for capability "${capability}": ${reason}`);
    this.name = 'ProviderUnavailableError';
    this.capability = capability;
  }
}
