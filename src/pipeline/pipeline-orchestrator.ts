/**
 * PipelineOrchestrator — 可扩展管线编排器
 * FR-K01
 *
 * 管线由有序阶段组成，每个阶段独立执行、独立可跳过。
 * 新增处理阶段只需注册到管线，不修改已有阶段逻辑。
 *
 * 默认阶段顺序：
 * extraction → analysis_artifact → classification → conflict_detection → merge_detection → persistence
 */

import { randomUUID } from 'node:crypto';
import type {
  KnowledgeEntry,
  KnowledgeSource,
  PipelineEvent,
  PipelineStage,
  ExtractionTask,
} from '../types/index.js';
import { EventBus } from './event-bus.js';

/** 管线阶段执行上下文 */
export interface StageContext {
  taskId: string;
  source: KnowledgeSource;
  input: string;
  /** 当前阶段可读写的条目列表 */
  entries: KnowledgeEntry[];
  /** 阶段间共享的元数据 */
  metadata: Record<string, unknown>;
  /** 事件总线引用 */
  bus: EventBus;
}

/** 管线阶段执行结果 */
export interface StageResult {
  /** 处理后的条目列表（替换 context.entries） */
  entries: KnowledgeEntry[];
  /** 阶段产出的元数据（合并到 context.metadata） */
  metadata?: Record<string, unknown>;
  /** 是否中断管线（后续阶段不再执行） */
  halt?: boolean;
  /** 中断原因 */
  haltReason?: string;
}

/** 管线阶段接口 */
export interface PipelineStageHandler {
  /** 阶段名称 */
  readonly name: PipelineStage;
  /** 执行阶段逻辑 */
  execute(context: StageContext): Promise<StageResult>;
}

/** 管线配置 */
export interface PipelineOrchestratorOptions {
  /** 要跳过的阶段名称列表 */
  skipStages?: PipelineStage[];
  /** 置信度阈值，低于此值的条目标记为 pending */
  confidenceThreshold?: number;
}

/** 管线任务状态 */
export interface OrchestratorTask {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'halted';
  input: string;
  source: KnowledgeSource;
  entries: KnowledgeEntry[];
  metadata: Record<string, unknown>;
  completedStages: PipelineStage[];
  skippedStages: PipelineStage[];
  failedStage?: PipelineStage;
  haltReason?: string;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

export class PipelineOrchestrator {
  readonly bus: EventBus;
  private readonly stages: PipelineStageHandler[] = [];
  private readonly skipStages: Set<PipelineStage>;
  private readonly tasks = new Map<string, OrchestratorTask>();

  constructor(options: PipelineOrchestratorOptions = {}) {
    this.bus = new EventBus();
    this.skipStages = new Set(options.skipStages ?? []);
  }

  /**
   * 注册管线阶段（按注册顺序执行）
   * FR-K01 AC4：新增处理阶段只需注册到管线
   */
  registerStage(handler: PipelineStageHandler): void {
    // 防止重复注册
    if (this.stages.some(s => s.name === handler.name)) {
      throw new Error(`Stage "${handler.name}" already registered`);
    }
    this.stages.push(handler);
  }

  /**
   * 在指定阶段之前插入新阶段
   */
  registerStageBefore(handler: PipelineStageHandler, beforeStage: PipelineStage): void {
    if (this.stages.some(s => s.name === handler.name)) {
      throw new Error(`Stage "${handler.name}" already registered`);
    }
    const idx = this.stages.findIndex(s => s.name === beforeStage);
    if (idx < 0) {
      this.stages.push(handler);
    } else {
      this.stages.splice(idx, 0, handler);
    }
  }

  /**
   * 在指定阶段之后插入新阶段
   */
  registerStageAfter(handler: PipelineStageHandler, afterStage: PipelineStage): void {
    if (this.stages.some(s => s.name === handler.name)) {
      throw new Error(`Stage "${handler.name}" already registered`);
    }
    const idx = this.stages.findIndex(s => s.name === afterStage);
    if (idx < 0) {
      this.stages.push(handler);
    } else {
      this.stages.splice(idx + 1, 0, handler);
    }
  }

  /**
   * 动态设置要跳过的阶段
   */
  setSkipStages(stages: PipelineStage[]): void {
    this.skipStages.clear();
    for (const s of stages) this.skipStages.add(s);
  }

  /**
   * 获取已注册的阶段列表（按执行顺序）
   */
  getRegisteredStages(): PipelineStage[] {
    return this.stages.map(s => s.name);
  }

  /**
   * 提交输入到管线，异步执行
   * 返回任务 ID
   */
  submit(input: string, source: KnowledgeSource): string {
    const task: OrchestratorTask = {
      id: randomUUID(),
      status: 'pending',
      input,
      source,
      entries: [],
      metadata: {},
      completedStages: [],
      skippedStages: [],
      createdAt: new Date(),
    };

    this.tasks.set(task.id, task);
    this.emitEvent('task:created', task.id, 'intake', { inputLength: input.length });

    this.runPipeline(task).catch(err => {
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
      this.emitEvent('task:failed', task.id, task.failedStage ?? 'intake', { error: task.error });
    });

    return task.id;
  }

  /**
   * 同步执行管线（等待完成）
   */
  async execute(input: string, source: KnowledgeSource): Promise<OrchestratorTask> {
    const task: OrchestratorTask = {
      id: randomUUID(),
      status: 'pending',
      input,
      source,
      entries: [],
      metadata: {},
      completedStages: [],
      skippedStages: [],
      createdAt: new Date(),
    };

    this.tasks.set(task.id, task);
    this.emitEvent('task:created', task.id, 'intake', { inputLength: input.length });

    await this.runPipeline(task);
    return task;
  }

  getTask(taskId: string): OrchestratorTask | undefined {
    return this.tasks.get(taskId);
  }

  private async runPipeline(task: OrchestratorTask): Promise<void> {
    task.status = 'running';
    this.emitEvent('task:started', task.id, 'intake', {});

    for (const stage of this.stages) {
      // FR-K01 AC1：每个阶段独立可跳过
      if (this.skipStages.has(stage.name)) {
        task.skippedStages.push(stage.name);
        this.emitEvent('stage:skipped', task.id, stage.name, {});
        continue;
      }

      this.emitEvent('stage:entered', task.id, stage.name, {});

      try {
        const context: StageContext = {
          taskId: task.id,
          source: task.source,
          input: task.input,
          entries: task.entries,
          metadata: task.metadata,
          bus: this.bus,
        };

        const result = await stage.execute(context);

        // 更新任务状态
        task.entries = result.entries;
        if (result.metadata) {
          Object.assign(task.metadata, result.metadata);
        }
        task.completedStages.push(stage.name);

        this.emitEvent('stage:completed', task.id, stage.name, {
          entryCount: result.entries.length,
          ...(result.metadata ?? {}),
        });

        // FR-K01 AC3：任一阶段失败时管线中断
        if (result.halt) {
          task.status = 'halted';
          task.haltReason = result.haltReason;
          this.emitEvent('task:completed', task.id, 'complete', {
            halted: true,
            haltReason: result.haltReason,
            completedStages: task.completedStages,
          });
          return;
        }
      } catch (err) {
        task.status = 'failed';
        task.failedStage = stage.name;
        task.error = err instanceof Error ? err.message : String(err);
        this.emitEvent('task:failed', task.id, stage.name, {
          error: task.error,
          failureContext: { completedStages: task.completedStages },
        });
        throw err;
      }
    }

    task.status = 'completed';
    task.completedAt = new Date();
    this.emitEvent('task:completed', task.id, 'complete', {
      totalEntries: task.entries.length,
      completedStages: task.completedStages,
      skippedStages: task.skippedStages,
      duration: task.completedAt.getTime() - task.createdAt.getTime(),
    });
  }

  private emitEvent(
    type: PipelineEvent['type'],
    taskId: string,
    stage: PipelineStage,
    payload: Record<string, unknown>,
  ): void {
    this.bus.emit({ type, taskId, stage, timestamp: new Date(), payload });
  }

  destroy(): void {
    this.bus.removeAllListeners();
    this.tasks.clear();
  }
}
