/**
 * Conflict Detection SPI — Embedding 和 LLM 通过接口调用，不绑定特定 provider
 */

import type { KnowledgeEntry } from '../types/index.js';
import type { ConflictVerdict } from './conflict-record.js';

/** Embedding 向量化 SPI */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

/** LLM 冲突精判 SPI */
export interface LLMJudgeProvider {
  /**
   * 判定两条知识是否对同一主题给出互斥结论
   * 返回：conflict / compatible / unrelated
   */
  judgeConflict(incoming: KnowledgeEntry, existing: KnowledgeEntry): Promise<ConflictVerdict>;
}
