/**
 * Dictionary Module — Type Definitions
 * 术语是 KnowledgeEntry 的特化视图（ADR-010）
 */

import type { KnowledgeMetadata, KnowledgeSource } from '../types/index.js';

/** 术语扩展元数据，存放在 KnowledgeEntry.metadata 中 */
export interface TermMetadata extends KnowledgeMetadata {
  term: string;
  aliases: string[];
  definition: string;
  constraints: string[];
  positiveExamples: string[];
  negativeExamples: string[];
  scope: string[];
  governanceSource?: string;
  deprecationReplacementTermId?: string;
}

/** 术语注册输入 */
export interface TermRegistrationInput {
  term: string;
  definition: string;
  constraints?: string[];
  aliases?: string[];
  positiveExamples?: string[];
  negativeExamples?: string[];
  scope: string[];
  source: KnowledgeSource;
  governanceSource?: string;
}

/** 术语更新补丁 */
export interface TermUpdatePatch {
  definition?: string;
  constraints?: string[];
  aliases?: string[];
  positiveExamples?: string[];
  negativeExamples?: string[];
  scope?: string[];
}

/** 术语冲突检测结果 */
export interface TermConflictResult {
  type: 'alias_conflict' | 'scope_overlap' | 'semantic_contradiction';
  incomingId: string;
  existingId: string;
  details: string;
  suggestion: 'merge' | 'modify' | 'deprecate_one';
}

/** 批量导入报告 */
export interface ImportReport {
  total: number;
  succeeded: number;
  conflicted: number;
  skipped: number;
  failed: number;
  details: ImportDetail[];
}

/** 导入明细 */
export interface ImportDetail {
  term: string;
  status: 'succeeded' | 'conflicted' | 'skipped' | 'failed';
  reason?: string;
  conflictWith?: string;
}

/** 词典模块配置 */
export interface DictionaryConfig {
  conflict: {
    embeddingSimilarityThreshold: number;
  };
  injection: {
    priorityBoost: number;
    maxTokens?: number;
  };
}

/** 默认词典配置 */
export const DEFAULT_DICTIONARY_CONFIG: DictionaryConfig = {
  conflict: {
    embeddingSimilarityThreshold: 0.80,
  },
  injection: {
    priorityBoost: 2.0,
    maxTokens: 400,
  },
};

/** 术语变更事件类型 */
export type TermChangeEventType = 'registered' | 'updated' | 'deprecated' | 'merged';

/** 术语变更事件 */
export interface TermChangeEvent {
  type: TermChangeEventType;
  entryId: string;
  term: string;
  timestamp: Date;
  payload: Record<string, unknown>;
}

export type TermChangeHandler = (event: TermChangeEvent) => void | Promise<void>;

/** 词典域常量 */
export const DICTIONARY_DOMAIN = 'system-dictionary';
export const DICTIONARY_TAG = 'term';
