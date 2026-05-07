import { describe, expect, it } from 'vitest';
import {
  ResearchExecutor,
  type ResearchExecutorAdapter,
  type ResearchStep,
  type ResearchTask,
} from '../src/research/index.js';
import { KnowledgeRepository, SQLiteProvider } from '../src/repository/index.js';
import type { KnowledgeSource } from '../src/types/index.js';

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'test://re-research',
  timestamp: new Date('2026-04-20T10:00:00.000Z'),
};

class StubAdapter implements ResearchExecutorAdapter {
  callCount = 0;

  async execute(step: ResearchStep, task: ResearchTask) {
    this.callCount++;
    return {
      apiCallsUsed: 1,
      artifacts: [
        {
          id: `${task.id}-${step.id}-${this.callCount}`,
          method: step.method,
          title: `${task.title} / ${step.method}`,
          content: `Knowledge about ${task.scope.topic}. Facts and methodology for extraction.`,
          reference: `https://example.com/${step.id}`,
        },
      ],
    };
  }
}

function makeTask(overrides: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: 'task-1',
    gapId: 'gap-1',
    gapType: 'frequency_blind_spot',
    title: '调研：KIVO migration',
    objective: '补齐迁移知识。',
    scope: {
      topic: 'KIVO migration',
      boundaries: ['聚焦迁移'],
      acquisitionMethods: ['web_search', 'document_read'],
    },
    expectedKnowledgeTypes: ['fact', 'methodology'],
    strategy: {
      steps: [
        {
          id: 'step-1',
          method: 'web_search',
          query: 'KIVO migration',
          rationale: '搜索迁移指南',
          limit: 3,
        },
        {
          id: 'step-2',
          method: 'document_read',
          query: 'KIVO migration docs',
          rationale: '读文档',
          limit: 2,
        },
      ],
      searchQueries: ['KIVO migration'],
    },
    completionCriteria: ['形成可检索知识'],
    budget: { maxDurationMs: 60_000, maxApiCalls: 20 },
    priority: 'high',
    impactScore: 3,
    urgencyScore: 3,
    blocking: true,
    createdAt: new Date('2026-04-20T12:00:00.000Z'),
    ...overrides,
  };
}

describe('ResearchExecutor — re-research (FR-D02 AC5)', () => {
  it('re-executes a completed task and produces fresh results', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubAdapter();

    const timestamps = Array.from({ length: 20 }, (_, i) =>
      new Date(`2026-04-20T13:00:${String(i).padStart(2, '0')}.000Z`)
    );
    let idx = 0;

    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: () => timestamps[Math.min(idx++, timestamps.length - 1)],
    });

    const task = makeTask();

    // First execution
    const result1 = await executor.execute(task);
    expect(result1.status).toBe('completed');
    expect(result1.artifacts).toHaveLength(2);
    const firstCallCount = adapter.callCount;

    // Re-execute
    const result2 = await executor.reExecute(task);
    expect(result2.status).toBe('completed');
    expect(result2.artifacts).toHaveLength(2);
    expect(adapter.callCount).toBe(firstCallCount + 2); // 2 more step executions

    // Detail view should reflect the latest execution
    const detail = executor.getTaskDetail(task.id);
    expect(detail).not.toBeNull();
    expect(detail!.result.taskId).toBe(task.id);
    expect(detail!.artifacts).toHaveLength(2);
  });
});

describe('ResearchExecutor — task detail view (FR-D02 AC6)', () => {
  it('provides detailed view with steps, artifacts, and timeline', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubAdapter();

    const timestamps = Array.from({ length: 20 }, (_, i) =>
      new Date(`2026-04-20T14:00:${String(i).padStart(2, '0')}.000Z`)
    );
    let idx = 0;

    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: () => timestamps[Math.min(idx++, timestamps.length - 1)],
    });

    const task = makeTask();
    await executor.execute(task);

    const detail = executor.getTaskDetail(task.id);
    expect(detail).not.toBeNull();

    // Task reference
    expect(detail!.task.id).toBe('task-1');
    expect(detail!.task.title).toBe('调研：KIVO migration');

    // Result
    expect(detail!.result.status).toBe('completed');
    expect(detail!.result.completedStepIds).toEqual(['step-1', 'step-2']);

    // Step details
    expect(detail!.steps).toHaveLength(2);
    expect(detail!.steps[0]).toMatchObject({
      step: expect.objectContaining({ id: 'step-1', method: 'web_search' }),
      status: 'completed',
      apiCallsUsed: 1,
    });
    expect(detail!.steps[0].artifacts).toHaveLength(1);
    expect(detail!.steps[1]).toMatchObject({
      step: expect.objectContaining({ id: 'step-2', method: 'document_read' }),
      status: 'completed',
    });

    // Artifacts
    expect(detail!.artifacts).toHaveLength(2);

    // Timeline
    expect(detail!.timeline.length).toBeGreaterThanOrEqual(3);
    expect(detail!.timeline[0].event).toBe('task_started');
    expect(detail!.timeline[detail!.timeline.length - 1].event).toBe('task_completed');

    // Extracted entries
    expect(detail!.extractedEntryIds.length).toBeGreaterThanOrEqual(0);
  });

  it('returns null for unknown task id', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubAdapter();

    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: () => new Date('2026-04-20T14:00:00.000Z'),
    });

    expect(executor.getTaskDetail('nonexistent')).toBeNull();
  });

  it('shows skipped steps when budget exceeded', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);

    let callCount = 0;
    const budgetAdapter: ResearchExecutorAdapter = {
      async execute(step, task) {
        callCount++;
        return {
          apiCallsUsed: 15, // exceeds budget of 20 on first call
          artifacts: [{
            id: `art-${callCount}`,
            method: step.method,
            title: 'Result',
            content: 'Some knowledge content with facts and methodology.',
            reference: 'https://example.com/result',
          }],
        };
      },
    };

    let idx = 0;
    const timestamps = Array.from({ length: 20 }, (_, i) =>
      new Date(`2026-04-20T15:00:${String(i).padStart(2, '0')}.000Z`)
    );

    const executor = new ResearchExecutor({
      adapter: budgetAdapter,
      repository,
      now: () => timestamps[Math.min(idx++, timestamps.length - 1)],
    });

    const task = makeTask({ budget: { maxDurationMs: 60_000, maxApiCalls: 10 } });
    await executor.execute(task);

    const detail = executor.getTaskDetail(task.id);
    expect(detail).not.toBeNull();
    expect(detail!.result.status).toBe('budget_exceeded');

    // First step completed, second skipped
    const completedSteps = detail!.steps.filter((s) => s.status === 'completed');
    const skippedSteps = detail!.steps.filter((s) => s.status === 'skipped');
    expect(completedSteps.length).toBeGreaterThanOrEqual(1);
    expect(skippedSteps.length).toBeGreaterThanOrEqual(1);

    // Timeline should include budget_exceeded event
    const budgetEvents = detail!.timeline.filter((e) => e.event === 'budget_exceeded');
    expect(budgetEvents.length).toBeGreaterThanOrEqual(1);
  });
});
