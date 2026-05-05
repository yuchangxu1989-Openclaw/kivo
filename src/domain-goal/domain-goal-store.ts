/**
 * DomainGoalStore — 域目标配置的 CRUD 管理
 *
 * FR-M01:
 * - AC1: 域目标声明字段完整
 * - AC2: 支持创建、编辑、删除
 * - AC3: 变更时生成变更事件
 */

import type {
  DomainGoal,
  DomainGoalInput,
  DomainGoalChangeEvent,
  DomainGoalChangeListener,
} from './domain-goal-types.js';

export class DomainGoalStore {
  private goals = new Map<string, DomainGoal>();
  private listeners: DomainGoalChangeListener[] = [];

  /** 注册变更监听器 */
  onChange(listener: DomainGoalChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** 创建域目标 (AC2) */
  create(input: DomainGoalInput): DomainGoal {
    if (this.goals.has(input.domainId)) {
      throw new Error(`Domain goal already exists: ${input.domainId}`);
    }
    const now = new Date();
    const goal: DomainGoal = {
      domainId: input.domainId,
      purpose: input.purpose,
      keyQuestions: input.keyQuestions ?? [],
      nonGoals: input.nonGoals ?? [],
      researchBoundary: input.researchBoundary ?? '',
      prioritySignals: input.prioritySignals ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.goals.set(goal.domainId, goal);
    this.emit({ type: 'created', domainId: goal.domainId, timestamp: now, current: goal });
    return goal;
  }

  /** 编辑域目标 (AC2) */
  update(domainId: string, patch: Partial<Omit<DomainGoalInput, 'domainId'>>): DomainGoal | null {
    const existing = this.goals.get(domainId);
    if (!existing) return null;

    const now = new Date();
    const previous = { ...existing };
    const updated: DomainGoal = {
      ...existing,
      ...(patch.purpose !== undefined && { purpose: patch.purpose }),
      ...(patch.keyQuestions !== undefined && { keyQuestions: patch.keyQuestions }),
      ...(patch.nonGoals !== undefined && { nonGoals: patch.nonGoals }),
      ...(patch.researchBoundary !== undefined && { researchBoundary: patch.researchBoundary }),
      ...(patch.prioritySignals !== undefined && { prioritySignals: patch.prioritySignals }),
      updatedAt: now,
    };
    this.goals.set(domainId, updated);
    this.emit({ type: 'updated', domainId, timestamp: now, previous, current: updated });
    return updated;
  }

  /** 删除域目标 (AC2) */
  delete(domainId: string): boolean {
    const existing = this.goals.get(domainId);
    if (!existing) return false;
    this.goals.delete(domainId);
    this.emit({ type: 'deleted', domainId, timestamp: new Date(), previous: existing });
    return true;
  }

  /** 获取单个域目标 */
  get(domainId: string): DomainGoal | null {
    return this.goals.get(domainId) ?? null;
  }

  /** 列出所有域目标 */
  list(): DomainGoal[] {
    return Array.from(this.goals.values());
  }

  /** 检查域目标是否存在 */
  has(domainId: string): boolean {
    return this.goals.has(domainId);
  }

  private emit(event: DomainGoalChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener errors should not break the store
      }
    }
  }
}
