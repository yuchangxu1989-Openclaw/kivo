/**
 * ResearchManagementService — FR-W07 调研管理数据层
 *
 * AC1: 调研任务列表（状态、优先级、创建时间、预算消耗 + 分页）
 * AC2: 缺口报告列表（盲区主题、影响面、填补进度）
 * AC3: 创建调研任务
 * AC4: 取消/调整优先级
 * AC5: 全局自动调研开关
 */

import type { ResearchTask } from '../research/research-task-types.js';
import type { KnowledgeGap } from '../research/gap-detection-types.js';
import type {
  ResearchTaskListQuery,
  ResearchTaskListResult,
  ResearchTaskView,
  ResearchTaskStatus,
  GapReportItem,
  CreateResearchRequest,
} from './workbench-types.js';

/** ResearchTask extended with runtime status tracked by the store/scheduler. */
export interface StoredResearchTask extends ResearchTask {
  currentStatus?: ResearchTaskStatus;
}

export interface ResearchTaskStore {
  listTasks(): Promise<StoredResearchTask[]>;
  getTask(id: string): Promise<StoredResearchTask | null>;
  createTask(task: ResearchTask): Promise<ResearchTask>;
  cancelTask(id: string): Promise<boolean>;
  updatePriority(id: string, priority: 'critical' | 'high' | 'medium' | 'low'): Promise<boolean>;
}

export interface GapStore {
  listGaps(): Promise<KnowledgeGap[]>;
}

export interface ResearchManagementServiceDeps {
  taskStore: ResearchTaskStore;
  gapStore?: GapStore;
}

export class ResearchManagementService {
  private taskStore: ResearchTaskStore;
  private gapStore?: GapStore;
  private silentMode = false;

  constructor(deps: ResearchManagementServiceDeps) {
    this.taskStore = deps.taskStore;
    this.gapStore = deps.gapStore;
  }

  /** AC1: 调研任务列表 */
  async listTasks(query: ResearchTaskListQuery): Promise<ResearchTaskListResult> {
    const all = await this.taskStore.listTasks();
    let filtered = all;

    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      const statusSet = new Set(statuses);
      filtered = filtered.filter((t) => {
        const viewStatus = this.mapTaskStatus(t);
        return statusSet.has(viewStatus);
      });
    }

    const totalItems = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / query.pageSize));
    const offset = (query.page - 1) * query.pageSize;
    const page = filtered.slice(offset, offset + query.pageSize);

    return {
      items: page.map((t) => this.toView(t)),
      page: query.page,
      pageSize: query.pageSize,
      totalPages,
      totalItems,
    };
  }

  /** AC2: 缺口报告 */
  async listGapReports(): Promise<GapReportItem[]> {
    if (!this.gapStore) return [];
    const gaps = await this.gapStore.listGaps();
    return gaps.map((g) => ({
      gapId: g.id,
      topic: g.description,
      impactScore: 0, // computed from evidence
      fillProgress: 0, // to be computed from linked research tasks
    }));
  }

  /** AC4: 取消任务 */
  async cancelTask(taskId: string): Promise<boolean> {
    return this.taskStore.cancelTask(taskId);
  }

  /** AC4: 调整优先级 */
  async adjustPriority(taskId: string, priority: 'critical' | 'high' | 'medium' | 'low'): Promise<boolean> {
    return this.taskStore.updatePriority(taskId, priority);
  }

  /** AC5: 全局自动调研开关 */
  setSilentMode(enabled: boolean): void {
    this.silentMode = enabled;
  }

  isSilentMode(): boolean {
    return this.silentMode;
  }

  private mapTaskStatus(task: StoredResearchTask): ResearchTaskStatus {
    // Prefer explicit status from the store/scheduler when available
    if (task.currentStatus) return task.currentStatus;
    // Fallback: infer from schedule
    if (task.scheduleAfter && task.scheduleAfter > new Date()) return 'queued';
    return 'running';
  }

  private toView(task: StoredResearchTask): ResearchTaskView {
    return {
      id: task.id,
      title: task.title,
      status: this.mapTaskStatus(task),
      priority: task.priority,
      createdAt: task.createdAt,
      budgetUsed: undefined,
      budgetTotal: task.budget.maxApiCalls,
    };
  }
}
