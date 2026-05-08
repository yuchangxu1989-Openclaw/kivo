/**
 * StandaloneAdapter — 独立运行适配器（测试/CLI）
 *
 * 纯内存操作，不依赖 OpenClaw 环境。
 * 用于单元测试、CLI 工具、独立部署场景。
 */

import type { KivoHostAdapter, SessionContext } from './host-adapter.js';
import type { HostCapabilityDeclaration } from './capability-registry.js';
import type { KnowledgeEntry } from '../types/index.js';
import type { Kivo } from '../kivo.js';
import type { ContextInjector } from '../injection/context-injector.js';

export interface StandaloneAdapterOptions {
  kivo: Kivo;
  injector: ContextInjector;
  /** 内存模式 SQLite 路径，默认 ':memory:' */
  storagePath?: string;
  /** 知识更新回调（可选，默认收集到内部数组） */
  onUpdate?: (entry: KnowledgeEntry) => void;
  capabilities?: HostCapabilityDeclaration[];
}

export class StandaloneAdapter implements KivoHostAdapter {
  private readonly kivo: Kivo;
  private readonly injector: ContextInjector;
  private readonly storagePath: string;
  private readonly onUpdate?: (entry: KnowledgeEntry) => void;
  private hostCapabilities: HostCapabilityDeclaration[];

  /** 收集所有知识更新事件，方便测试断言 */
  readonly updates: KnowledgeEntry[] = [];

  constructor(options: StandaloneAdapterOptions) {
    this.kivo = options.kivo;
    this.injector = options.injector;
    this.storagePath = options.storagePath ?? ':memory:';
    this.onUpdate = options.onUpdate;
    this.hostCapabilities = options.capabilities ?? [
      { name: 'llm', version: '1.0.0', contract: 'prompt->completion', available: false },
      { name: 'network', version: '1.0.0', contract: 'http-fetch', available: false },
      { name: 'file-read', version: '1.0.0', contract: 'memory-read', available: true },
      { name: 'file-write', version: '1.0.0', contract: 'memory-write', available: true },
      { name: 'tool-exec', version: '1.0.0', contract: 'none', available: false },
    ];
  }

  async onSessionMessage(msg: string, context: SessionContext): Promise<void> {
    const source = context.agentId
      ? `${context.sessionId}:${context.agentId}`
      : context.sessionId;

    const result = await this.kivo.ingest(msg, source);

    for (const entry of result.entries) {
      this.onKnowledgeUpdate(entry);
    }
  }

  async injectContext(query: string, budget: number): Promise<string> {
    const response = await this.injector.inject({
      userQuery: query,
      tokenBudget: budget,
    });
    return response.injectedContext;
  }

  getStoragePath(): string {
    return this.storagePath;
  }

  registerHostCapabilities(capabilities: HostCapabilityDeclaration[]): void {
    this.hostCapabilities = capabilities.map(capability => ({
      ...capability,
      metadata: capability.metadata ? { ...capability.metadata } : undefined,
    }));
  }

  getHostCapabilities(): HostCapabilityDeclaration[] {
    return this.hostCapabilities.map(capability => ({
      ...capability,
      metadata: capability.metadata ? { ...capability.metadata } : undefined,
    }));
  }

  async readSource(reference: string): Promise<string> {
    return `memory://${reference}`;
  }

  async writeExport(_path: string, _content: string): Promise<void> {
    return;
  }

  onKnowledgeUpdate(entry: KnowledgeEntry): void {
    this.updates.push(entry);
    this.onUpdate?.(entry);
  }
}
