/**
 * Bulk Export Types — 知识库批量导出
 *
 * FR-X03:
 * - AC1: 按域、类型、状态、时间范围筛选
 * - AC2: 包含完整数据（元数据、内容、关联、版本历史）和冲突记录
 * - AC3: 包含格式版本号
 */

import type { KnowledgeType, EntryStatus, KnowledgeEntry } from '../types/index.js';
import type { ConflictRecord } from '../conflict/index.js';

export const EXPORT_FORMAT_VERSION = '1.0.0';

export interface ExportFilter {
  domains?: string[];
  types?: KnowledgeType[];
  statuses?: EntryStatus[];
  timeRange?: {
    start?: Date;
    end?: Date;
  };
}

export interface ExportPackage {
  formatVersion: string;
  exportedAt: string;
  filter: ExportFilter;
  entries: KnowledgeEntry[];
  conflicts: ConflictRecord[];
  totalEntries: number;
  totalConflicts: number;
}
