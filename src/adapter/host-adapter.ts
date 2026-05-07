/**
 * KivoHostAdapter — 宿主接入层抽象接口
 *
 * 核心流程通用化设计，宿主特有能力通过 Adapter 接入。
 * 对应 arc42 Host Adapter 模式：核心通用 + 宿主能力通过 Adapter 接入。
 */

import type { KnowledgeEntry } from '../types/index.js';
import type { HostCapabilityDeclaration } from './capability-registry.js';

/**
 * 会话上下文，由宿主环境提供
 */
export interface SessionContext {
  /** 会话 ID */
  sessionId: string;
  /** 发起 Agent 标识（可选） */
  agentId?: string;
  /** 知识来源类型 */
  sourceType?: 'conversation' | 'document' | 'research' | 'manual' | 'system';
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 宿主适配器接口 — 所有宿主环境必须实现此接口
 */
export interface KivoHostAdapter {
  /** 会话消息触发知识提取 */
  onSessionMessage(msg: string, context: SessionContext): Promise<void>;

  /** 为 Agent 注入上下文（返回格式化后的知识片段） */
  injectContext(query: string, budget: number): Promise<string>;

  /** 获取 SQLite 存储路径 */
  getStoragePath(): string;

  /** 注册并声明宿主能力 */
  registerHostCapabilities?(capabilities: HostCapabilityDeclaration[]): Promise<void> | void;

  /** 获取宿主当前能力声明 */
  getHostCapabilities?(): Promise<HostCapabilityDeclaration[]> | HostCapabilityDeclaration[];

  /** 读取来源内容 */
  readSource?(reference: string): Promise<string>;

  /** 写导出内容 */
  writeExport?(path: string, content: string): Promise<void>;

  /** 知识更新回调 */
  onKnowledgeUpdate(entry: KnowledgeEntry): void;
}
