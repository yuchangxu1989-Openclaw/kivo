/**
 * EntryDetailService — FR-W03 知识条目详情数据层
 *
 * AC1: 完整内容、来源引用、版本历史时间线、关联关系
 * AC2: 关联关系可点击跳转
 * AC3: 版本差异对比
 */

import type { StorageAdapter } from '../storage/storage-types.js';
import type { KnowledgeEntry } from '../types/index.js';
import type {
  EntryDetail,
  VersionRecord,
  VersionDiff,
  FieldChange,
  AssociationLink,
} from './workbench-types.js';

export interface AssociationProvider {
  getAssociations(entryId: string): Promise<AssociationLink[]>;
}

export interface EntryDetailServiceDeps {
  storage: StorageAdapter;
  associations?: AssociationProvider;
}

export class EntryDetailService {
  private storage: StorageAdapter;
  private associations?: AssociationProvider;

  constructor(deps: EntryDetailServiceDeps) {
    this.storage = deps.storage;
    this.associations = deps.associations;
  }

  /** AC1: 获取条目详情（含版本历史 + 关联关系） */
  async getDetail(entryId: string): Promise<EntryDetail | null> {
    const entry = await this.storage.get(entryId);
    if (!entry) return null;

    const versions = await this.storage.getVersionHistory(entryId);
    const versionHistory: VersionRecord[] = versions.map((v) => ({
      version: v.version,
      updatedAt: v.updatedAt,
      changeSummary: v.version === 1 ? '初始创建' : undefined,
    }));

    const associations = this.associations
      ? await this.associations.getAssociations(entryId)
      : [];

    return { entry, versionHistory, associations };
  }

  /** AC3: 版本差异对比 */
  async diffVersions(entryId: string, fromVersion: number, toVersion: number): Promise<VersionDiff | null> {
    const history = await this.storage.getVersionHistory(entryId);
    const fromEntry = history.find((v) => v.version === fromVersion);
    const toEntry = history.find((v) => v.version === toVersion);
    if (!fromEntry || !toEntry) return null;

    const changes: FieldChange[] = [];
    const fields: (keyof KnowledgeEntry)[] = ['title', 'content', 'summary', 'status', 'confidence'];
    for (const field of fields) {
      const oldVal = fromEntry[field];
      const newVal = toEntry[field];
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        changes.push({ field, oldValue: oldVal, newValue: newVal });
      }
    }

    return { fromVersion, toVersion, changes };
  }
}
