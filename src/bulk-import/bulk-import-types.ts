/**
 * Bulk Import Types — 知识库批量导入
 *
 * FR-X04:
 * - AC1: 格式版本兼容性校验
 * - AC2: 逐条冲突检测，冲突标记 pending
 * - AC3: 导入报告
 * - AC4: dry-run 模式
 */

import type { KnowledgeEntry } from '../types/index.js';

export interface ImportReport {
  totalEntries: number;
  imported: number;
  skipped: number;
  conflicts: number;
  errors: ImportError[];
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
}

export interface ImportError {
  entryId: string;
  reason: string;
}

export interface ImportOptions {
  /** AC4: 干跑模式，仅输出报告不实际写入 */
  dryRun?: boolean;
}

export interface ImportValidationResult {
  valid: boolean;
  formatVersion: string;
  reason?: string;
}

/** 兼容的格式版本列表 */
export const COMPATIBLE_FORMAT_VERSIONS = ['1.0.0'];
