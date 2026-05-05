/**
 * OpenClawAdapter — OpenClaw 宿主实现
 *
 * 将 Kivo 核心能力接入 OpenClaw 运行时环境。
 * - onSessionMessage → Kivo.ingest()
 * - injectContext → ContextInjector
 * - getStoragePath → ~/.openclaw/workspace/state/kivo.db
 * - onKnowledgeUpdate → EventBus 事件广播
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { KivoHostAdapter, SessionContext } from './host-adapter.js';
import type { HostCapabilityDeclaration } from './capability-registry.js';
import type { KnowledgeEntry } from '../types/index.js';
import type { Kivo } from '../kivo.js';
import type { ContextInjector } from '../injection/context-injector.js';
import type { EventBus } from '../pipeline/event-bus.js';

export interface OpenClawAdapterOptions {
  kivo: Kivo;
  injector: ContextInjector;
  eventBus: EventBus;
  /** 覆盖默认存储路径（测试用） */
  storagePath?: string;
  capabilities?: HostCapabilityDeclaration[];
}

export class OpenClawAdapter implements KivoHostAdapter {
  private readonly kivo: Kivo;
  private readonly injector: ContextInjector;
  private readonly eventBus: EventBus;
  private readonly storagePath: string;
  private hostCapabilities: HostCapabilityDeclaration[];

  constructor(options: OpenClawAdapterOptions) {
    this.kivo = options.kivo;
    this.injector = options.injector;
    this.eventBus = options.eventBus;
    this.storagePath = options.storagePath
      ?? join(homedir(), '.openclaw', 'workspace', 'state', 'kivo.db');
    this.hostCapabilities = options.capabilities ?? [
      { name: 'llm', version: '1.0.0', contract: 'prompt->completion', available: true },
      { name: 'network', version: '1.0.0', contract: 'http-fetch', available: true },
      { name: 'file-read', version: '1.0.0', contract: 'workspace-read', available: true },
      { name: 'file-write', version: '1.0.0', contract: 'workspace-write', available: true },
      { name: 'tool-exec', version: '1.0.0', contract: 'tool-call', available: true },
    ];
  }

  async onSessionMessage(msg: string, context: SessionContext): Promise<void> {
    const source = context.agentId
      ? `${context.sessionId}:${context.agentId}`
      : context.sessionId;

    const result = await this.kivo.ingest(msg, source);

    // 广播每个新提取的知识条目
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
    return `openclaw://${reference}`;
  }

  async writeExport(_path: string, _content: string): Promise<void> {
    return;
  }

  onKnowledgeUpdate(entry: KnowledgeEntry): void {
    this.eventBus.emit({
      type: 'entry:extracted',
      taskId: `adapter-${entry.id}`,
      stage: 'complete',
      timestamp: new Date(),
      payload: { entry },
    });
  }
}
