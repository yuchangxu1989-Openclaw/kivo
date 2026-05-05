/**
 * EntryOperationService — FR-W06 知识条目操作数据层
 *
 * AC1: 状态变更（active→deprecated, pending→active/archived）
 * AC2: 状态机约束（仅展示当前状态可用操作）
 * AC3: 编辑提交生成新版本 + 冲突检测
 * AC4: 乐观锁（expectedVersion）
 */

import type { StorageAdapter } from '../storage/storage-types.js';
import type { KnowledgeEntry } from '../types/index.js';
import type {
  StatusChangeRequest,
  StatusChangeResult,
  EditRequest,
  EditResult,
  EntryOperation,
} from './workbench-types.js';
import { availableOperations, resolveNewStatus, VersionConflictError } from './workbench-types.js';

export interface ConflictDetectionTrigger {
  triggerForEntry(entry: KnowledgeEntry): Promise<void>;
}

export interface EntryOperationServiceDeps {
  storage: StorageAdapter;
  conflictDetection?: ConflictDetectionTrigger;
}

export class EntryOperationService {
  private storage: StorageAdapter;
  private conflictDetection?: ConflictDetectionTrigger;

  constructor(deps: EntryOperationServiceDeps) {
    this.storage = deps.storage;
    this.conflictDetection = deps.conflictDetection;
  }

  /** AC2: 获取当前状态可用操作 */
  getAvailableOperations(entry: KnowledgeEntry): EntryOperation[] {
    return availableOperations(entry.status);
  }

  /** AC1: 执行状态变更 */
  async changeStatus(request: StatusChangeRequest): Promise<StatusChangeResult> {
    const entry = await this.storage.get(request.entryId);
    if (!entry) {
      throw new Error(`Entry ${request.entryId} not found`);
    }

    const allowed = availableOperations(entry.status);
    if (!allowed.includes(request.operation)) {
      throw new Error(
        `Operation '${request.operation}' not allowed on status '${entry.status}'. Allowed: ${allowed.join(', ')}`,
      );
    }

    const newStatus = resolveNewStatus(entry.status, request.operation);
    await this.storage.update(request.entryId, { status: newStatus });

    return {
      entryId: request.entryId,
      previousStatus: entry.status,
      newStatus,
      operatorId: request.operatorId,
      changedAt: new Date(),
    };
  }

  /** AC3 + AC4: 编辑条目（乐观锁 + 新版本 + 冲突检测） */
  async editEntry(request: EditRequest): Promise<EditResult> {
    const entry = await this.storage.get(request.entryId);
    if (!entry) {
      throw new Error(`Entry ${request.entryId} not found`);
    }

    // AC4: 乐观锁检查
    if (entry.version !== request.expectedVersion) {
      throw new VersionConflictError(request.entryId, request.expectedVersion, entry.version);
    }

    const updated = await this.storage.update(request.entryId, {
      ...request.patch,
      // version increment is handled by storage adapter
    });

    if (!updated) {
      throw new Error(`Failed to update entry ${request.entryId}`);
    }

    // AC3: 触发冲突检测管线
    let conflictDetectionTriggered = false;
    if (this.conflictDetection) {
      await this.conflictDetection.triggerForEntry(updated);
      conflictDetectionTriggered = true;
    }

    return {
      entry: updated,
      newVersion: updated.version,
      conflictDetectionTriggered,
    };
  }
}
