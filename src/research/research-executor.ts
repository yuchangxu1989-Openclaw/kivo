import type { KnowledgeRepository } from '../repository/index.js';
import { ExtractionPipeline } from '../extraction/index.js';
import type { KnowledgeEntry, KnowledgeSource } from '../types/index.js';
import type {
  ResearchArtifact,
  ResearchResult,
  ResearchStep,
  ResearchStepResult,
  ResearchTask,
} from './research-task-types.js';

export interface ResearchExecutorAdapter {
  execute(step: ResearchStep, task: ResearchTask): Promise<ResearchStepResult>;
}

export interface ResearchExecutorOptions {
  adapter: ResearchExecutorAdapter;
  repository: KnowledgeRepository;
  extractionPipeline?: ExtractionPipeline;
  now?: () => Date;
}

/** FR-D02 AC6: Research task detail view */
export interface ResearchTaskDetail {
  task: ResearchTask;
  result: ResearchResult;
  steps: ResearchStepDetail[];
  artifacts: ResearchArtifact[];
  extractedEntryIds: string[];
  timeline: ResearchTimelineEvent[];
}

export interface ResearchStepDetail {
  step: ResearchStep;
  status: 'completed' | 'skipped';
  artifacts: ResearchArtifact[];
  apiCallsUsed: number;
}

export interface ResearchTimelineEvent {
  timestamp: Date;
  event: string;
  detail?: string;
}

interface BudgetState {
  startedAt: number;
  apiCalls: number;
}

export class ResearchExecutor {
  private readonly adapter: ResearchExecutorAdapter;
  private readonly repository: KnowledgeRepository;
  private readonly extractionPipeline: ExtractionPipeline;
  private readonly now: () => Date;

  private readonly resultHistory = new Map<string, ResearchResult>();
  private readonly taskRegistry = new Map<string, ResearchTask>();
  private readonly stepArtifacts = new Map<string, { step: ResearchStep; artifacts: ResearchArtifact[]; apiCalls: number }>();
  private readonly timelines = new Map<string, ResearchTimelineEvent[]>();

  constructor(options: ResearchExecutorOptions) {
    this.adapter = options.adapter;
    this.repository = options.repository;
    this.extractionPipeline = options.extractionPipeline ?? new ExtractionPipeline();
    this.now = options.now ?? (() => new Date());
  }

  async execute(task: ResearchTask): Promise<ResearchResult> {
    const startedAt = new Date(this.now());
    this.taskRegistry.set(task.id, task);
    const timeline: ResearchTimelineEvent[] = [
      { timestamp: new Date(startedAt), event: 'task_started', detail: task.title },
    ];
    const budgetState: BudgetState = {
      startedAt: startedAt.getTime(),
      apiCalls: 0,
    };
    const artifacts: ResearchArtifact[] = [];
    const extractedEntries: KnowledgeEntry[] = [];
    const savedEntryIds: string[] = [];
    const completedStepIds: string[] = [];
    const skippedStepIds: string[] = [];
    const failedStepIds: string[] = [];
    let terminationReason: string | undefined;
    let lastError: string | undefined;

    for (let index = 0; index < task.strategy.steps.length; index++) {
      const step = task.strategy.steps[index];
      if (isBudgetExceeded(task, budgetState, this.now)) {
        skippedStepIds.push(...task.strategy.steps.slice(index).map((pendingStep) => pendingStep.id));
        terminationReason = '资源预算已耗尽，停止后续调研步骤。';
        timeline.push({ timestamp: new Date(this.now()), event: 'budget_exceeded' });
        break;
      }

      timeline.push({ timestamp: new Date(this.now()), event: 'step_started', detail: `${step.method}: ${step.query}` });

      try {
        const stepResult = await this.adapter.execute(step, task);
        budgetState.apiCalls += stepResult.apiCallsUsed ?? 0;

        const stepArtifacts = stepResult.artifacts.map(cloneArtifact);
        artifacts.push(...stepArtifacts);

        this.stepArtifacts.set(`${task.id}:${step.id}`, {
          step,
          artifacts: stepArtifacts,
          apiCalls: stepResult.apiCallsUsed ?? 0,
        });

        for (const artifact of stepArtifacts) {
          const entries = await this.extractArtifact(artifact, task);
          for (const entry of entries) {
            extractedEntries.push(entry);
            const saved = await this.repository.save(entry);
            if (saved === false) {
              continue;
            }
            savedEntryIds.push(entry.id);
          }
        }

        completedStepIds.push(step.id);
        timeline.push({ timestamp: new Date(this.now()), event: 'step_completed', detail: `${step.id}: ${stepArtifacts.length} artifacts` });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        lastError = msg;
        failedStepIds.push(step.id);
        timeline.push({ timestamp: new Date(this.now()), event: 'step_failed', detail: `${step.id}: ${msg}` });
      }

      if (isBudgetExceeded(task, budgetState, this.now)) {
        skippedStepIds.push(...task.strategy.steps.slice(index + 1).map((pendingStep) => pendingStep.id));
        terminationReason = '调研达到预算上限，已返回部分结果。';
        timeline.push({ timestamp: new Date(this.now()), event: 'budget_exceeded' });
        break;
      }
    }

    const completedAt = new Date(this.now());
    let status: ResearchResult['status'];
    if (terminationReason) {
      status = 'budget_exceeded';
    } else if (completedStepIds.length > 0 && failedStepIds.length > 0) {
      status = 'partial_success';
    } else if (completedStepIds.length === 0 && failedStepIds.length > 0) {
      status = 'failed';
    } else {
      status = 'completed';
    }
    timeline.push({ timestamp: new Date(completedAt), event: status === 'failed' ? 'task_failed' : 'task_completed', detail: status });

    const result: ResearchResult = {
      taskId: task.id,
      status,
      startedAt,
      completedAt,
      consumedBudget: {
        elapsedMs: completedAt.getTime() - budgetState.startedAt,
        apiCalls: budgetState.apiCalls,
      },
      artifacts,
      extractedEntries,
      savedEntryIds,
      completedStepIds,
      skippedStepIds,
      summary: status === 'failed'
        ? `调研任务”${task.title}”执行失败。`
        : buildSummary(task, artifacts, extractedEntries, status, terminationReason),
      terminationReason,
      error: lastError,
    };

    this.resultHistory.set(task.id, result);
    this.timelines.set(task.id, timeline);
    return result;
  }

  /**
   * FR-D02 AC5: Re-research a completed task.
   * Clears previous results for this task and re-executes.
   */
  async reExecute(task: ResearchTask): Promise<ResearchResult> {
    const previousResult = this.resultHistory.get(task.id);
    if (previousResult) {
      for (const entryId of previousResult.savedEntryIds) {
        await this.repository.delete(entryId);
      }
    }
    this.resultHistory.delete(task.id);
    this.timelines.delete(task.id);
    for (const step of task.strategy.steps) {
      this.stepArtifacts.delete(`${task.id}:${step.id}`);
    }
    return this.execute(task);
  }

  /**
   * FR-D02 AC6: Get detailed view of a research task execution.
   */
  getTaskDetail(taskId: string): ResearchTaskDetail | null {
    const result = this.resultHistory.get(taskId);
    const task = this.taskRegistry.get(taskId);
    const timeline = this.timelines.get(taskId);

    if (!result || !task) return null;

    const steps: ResearchStepDetail[] = task.strategy.steps.map((step) => {
      const stepData = this.stepArtifacts.get(`${taskId}:${step.id}`);
      return {
        step,
        status: result.completedStepIds.includes(step.id) ? 'completed' : 'skipped',
        artifacts: stepData?.artifacts ?? [],
        apiCallsUsed: stepData?.apiCalls ?? 0,
      };
    });

    return {
      task,
      result,
      steps,
      artifacts: result.artifacts,
      extractedEntryIds: result.savedEntryIds,
      timeline: timeline ?? [],
    };
  }

  private async extractArtifact(artifact: ResearchArtifact, task: ResearchTask): Promise<KnowledgeEntry[]> {
    const source: KnowledgeSource = {
      type: 'research',
      reference: artifact.reference,
      timestamp: new Date(this.now()),
      context: task.id,
    };

    const markdown = [
      '---',
      `title: ${escapeFrontmatterValue(artifact.title)}`,
      `domain: ${escapeFrontmatterValue(task.scope.domain ?? task.scope.topic)}`,
      `tags: ${['research', ...task.expectedKnowledgeTypes, task.priority].join(', ')}`,
      '---',
      '',
      `# ${artifact.title}`,
      '',
      artifact.content,
      '',
    ].join('\n');

    return this.extractionPipeline.extractFromDocument(
      markdown,
      {
        path: artifact.reference,
        title: artifact.title,
      },
      source,
    );
  }
}

function isBudgetExceeded(task: ResearchTask, state: BudgetState, now: () => Date): boolean {
  const elapsedMs = now().getTime() - state.startedAt;
  return elapsedMs >= task.budget.maxDurationMs || state.apiCalls >= task.budget.maxApiCalls;
}

function cloneArtifact(artifact: ResearchArtifact): ResearchArtifact {
  return {
    id: artifact.id,
    method: artifact.method,
    title: artifact.title,
    content: artifact.content,
    reference: artifact.reference,
    metadata: artifact.metadata ? { ...artifact.metadata } : undefined,
  };
}

function buildSummary(
  task: ResearchTask,
  artifacts: ResearchArtifact[],
  entries: KnowledgeEntry[],
  status: ResearchResult['status'],
  terminationReason?: string,
): string {
  const base = `调研任务“${task.title}”产出 ${artifacts.length} 份资料，提取 ${entries.length} 条知识。`;
  if (status === 'budget_exceeded' && terminationReason) {
    return `${base}${terminationReason}`;
  }
  return base;
}

function escapeFrontmatterValue(value: string): string {
  const cleaned = value.replace(/\n/g, ' ').trim();
  const escaped = cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}
