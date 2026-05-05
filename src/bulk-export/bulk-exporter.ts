/**
 * BulkExporter — 知识库批量导出
 *
 * FR-X03:
 * - AC1: 按知识域、类型、状态、时间范围筛选导出，格式为 JSON
 * - AC2: 包含完整数据（元数据、内容、关联关系、版本历史）和冲突记录
 * - AC3: 导出文件包含格式版本号
 */

import type { KnowledgeEntry } from '../types/index.js';
import type { ConflictRecord } from '../conflict/index.js';
import type { ExportFilter, ExportPackage } from './bulk-export-types.js';
import { EXPORT_FORMAT_VERSION } from './bulk-export-types.js';

export interface BulkExportDataSource {
  /** 获取所有知识条目 */
  getAllEntries(): Promise<KnowledgeEntry[]>;
  /** 获取所有冲突记录 */
  getAllConflicts(): Promise<ConflictRecord[]>;
}

export class BulkExporter {
  constructor(private readonly dataSource: BulkExportDataSource) {}

  /**
   * 执行批量导出
   * AC1: 按筛选条件过滤
   * AC2: 包含完整数据
   * AC3: 包含格式版本号
   */
  async export(filter?: ExportFilter): Promise<ExportPackage> {
    const allEntries = await this.dataSource.getAllEntries();
    const allConflicts = await this.dataSource.getAllConflicts();

    const filteredEntries = this.filterEntries(allEntries, filter);
    const filteredConflicts = this.filterConflicts(allConflicts, filteredEntries);

    return {
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      filter: filter ?? {},
      entries: filteredEntries,
      conflicts: filteredConflicts,
      totalEntries: filteredEntries.length,
      totalConflicts: filteredConflicts.length,
    };
  }

  /** 导出为 JSON 字符串 */
  async exportToJson(filter?: ExportFilter, pretty = true): Promise<string> {
    const pkg = await this.export(filter);
    return pretty ? JSON.stringify(pkg, null, 2) : JSON.stringify(pkg);
  }

  private filterEntries(entries: KnowledgeEntry[], filter?: ExportFilter): KnowledgeEntry[] {
    if (!filter) return entries;

    return entries.filter(entry => {
      // AC1: 按域筛选
      if (filter.domains && filter.domains.length > 0) {
        const domain = entry.domain ?? 'default';
        if (!filter.domains.includes(domain)) return false;
      }

      // AC1: 按类型筛选
      if (filter.types && filter.types.length > 0) {
        if (!filter.types.includes(entry.type)) return false;
      }

      // AC1: 按状态筛选
      if (filter.statuses && filter.statuses.length > 0) {
        if (!filter.statuses.includes(entry.status)) return false;
      }

      // AC1: 按时间范围筛选
      if (filter.timeRange) {
        if (filter.timeRange.start && entry.createdAt < filter.timeRange.start) return false;
        if (filter.timeRange.end && entry.createdAt > filter.timeRange.end) return false;
      }

      return true;
    });
  }

  private filterConflicts(conflicts: ConflictRecord[], entries: KnowledgeEntry[]): ConflictRecord[] {
    const entryIds = new Set(entries.map(e => e.id));
    return conflicts.filter(c =>
      entryIds.has(c.incomingId) || entryIds.has(c.existingId)
    );
  }
}
