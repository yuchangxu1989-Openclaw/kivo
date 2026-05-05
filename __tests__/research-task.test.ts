import { describe, expect, it } from 'vitest';
import {
  GapDetector,
  ResearchExecutor,
  ResearchScheduler,
  ResearchTaskGenerator,
  type KnowledgeEntry,
  type KnowledgeSource,
  type ResearchExecutorAdapter,
  type ResearchStep,
  type ResearchTask,
} from '../src/index.js';
import { KnowledgeRepository, SQLiteProvider } from '../src/repository/index.js';

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'test://research-task',
  timestamp: new Date('2026-04-20T10:00:00.000Z'),
  agent: 'dev-01',
};

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = overrides.createdAt ?? new Date('2026-04-20T10:00:00.000Z');
  const updatedAt = overrides.updatedAt ?? new Date(createdAt.getTime());

  return {
    id,
    type: 'fact',
    title: `title-${id}`,
    content: `content-${id}`,
    summary: `summary-${id}`,
    source: testSource,
    confidence: 0.9,
    status: 'active',
    tags: ['core'],
    createdAt,
    updatedAt,
    version: 1,
    ...overrides,
  };
}

class StubResearchAdapter implements ResearchExecutorAdapter {
  readonly calls: string[] = [];

  async execute(step: ResearchStep, task: ResearchTask) {
    this.calls.push(step.id);
    return {
      apiCallsUsed: step.method === 'web_search' ? 2 : 1,
      artifacts: [
        {
          id: `${task.id}-${step.id}`,
          method: step.method,
          title: `${task.title} / ${step.method}`,
          content: `${task.scope.topic} knowledge from ${step.method}. Steps and facts for durable extraction.`,
          reference: `https://example.com/${step.id}`,
          metadata: { query: step.query },
        },
      ],
    };
  }
}

describe('ResearchTaskGenerator', () => {
  it('generates research tasks with objective, scope, strategy and completion criteria', () => {
    const detector = new GapDetector({
      now: () => new Date('2026-04-20T12:00:00.000Z'),
      idGenerator: (() => {
        let sequence = 0;
        return () => `gap-${++sequence}`;
      })(),
    });

    for (let index = 0; index < 5; index += 1) {
      detector.recordQueryMiss('OpenClaw browser lease failure');
    }

    const entries = [
      makeEntry({ id: 'growth-fact', domain: 'growth', type: 'fact' }),
      makeEntry({ id: 'growth-method', domain: 'growth', type: 'methodology' }),
    ];

    const links = [
      { sourceId: 'growth-fact', targetId: 'growth-method' },
    ];

    const result = detector.detect(entries, links);

    const generator = new ResearchTaskGenerator({
      now: () => new Date('2026-04-20T12:05:00.000Z'),
      idGenerator: (() => {
        let sequence = 0;
        return () => `task-${++sequence}`;
      })(),
    });

    const tasks = generator.generate(result);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      id: 'task-1',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: '调研：OpenClaw browser lease failure',
      priority: 'high',
      blocking: true,
      expectedKnowledgeTypes: ['fact', 'methodology', 'experience'],
      budget: {
        maxDurationMs: 600000,
        maxApiCalls: 12,
      },
    });
    expect(tasks[0].objective).toContain('高频查询盲区');
    expect(tasks[0].scope.acquisitionMethods).toEqual(['web_search', 'document_read']);
    expect(tasks[0].strategy.steps[0]).toMatchObject({
      method: 'web_search',
      query: 'OpenClaw browser lease failure',
    });
    expect(tasks[0].completionCriteria).toHaveLength(3);

    expect(tasks[1]).toMatchObject({
      id: 'task-2',
      gapType: 'structural_gap',
      title: '调研：补齐 growth 知识链',
      expectedKnowledgeTypes: ['experience'],
    });
    expect(tasks[1].scope.domain).toBe('growth');
    expect(tasks[1].strategy.steps.map((step) => step.method)).toEqual(['document_read', 'web_search']);
  });
});

describe('ResearchExecutor', () => {
  it('executes research steps, extracts knowledge and persists results', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubResearchAdapter();
    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: (() => {
        const timestamps = [
          new Date('2026-04-20T13:00:00.000Z'),
          new Date('2026-04-20T13:00:01.000Z'),
          new Date('2026-04-20T13:00:02.000Z'),
          new Date('2026-04-20T13:00:03.000Z'),
          new Date('2026-04-20T13:00:04.000Z'),
          new Date('2026-04-20T13:00:05.000Z'),
        ];
        let index = 0;
        return () => timestamps[Math.min(index++, timestamps.length - 1)];
      })(),
    });

    const task: ResearchTask = {
      id: 'task-research-1',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: '调研：OpenClaw browser lease failure',
      objective: '补齐租约失败问题。',
      scope: {
        topic: 'OpenClaw browser lease failure',
        boundaries: ['聚焦租约问题'],
        acquisitionMethods: ['web_search', 'document_read'],
      },
      expectedKnowledgeTypes: ['fact', 'methodology'],
      strategy: {
        steps: [
          {
            id: 'step-1',
            method: 'web_search',
            query: 'OpenClaw browser lease failure',
            rationale: '搜一手线索',
            limit: 4,
          },
          {
            id: 'step-2',
            method: 'document_read',
            query: 'browser lease doc',
            rationale: '补权威文档',
            limit: 2,
          },
        ],
        searchQueries: ['OpenClaw browser lease failure'],
      },
      completionCriteria: ['形成可检索知识'],
      budget: {
        maxDurationMs: 10_000,
        maxApiCalls: 10,
      },
      priority: 'high',
      impactScore: 3,
      urgencyScore: 3,
      blocking: true,
      createdAt: new Date('2026-04-20T12:59:00.000Z'),
    };

    const result = await executor.execute(task);

    expect(result.status).toBe('completed');
    expect(result.artifacts).toHaveLength(2);
    expect(result.completedStepIds).toEqual(['step-1', 'step-2']);
    expect(result.skippedStepIds).toEqual([]);
    expect(result.extractedEntries.length).toBeGreaterThan(0);
    expect(result.savedEntryIds).toHaveLength(result.extractedEntries.length);
    expect(result.consumedBudget.apiCalls).toBe(3);
    expect(result.summary).toContain('产出 2 份资料');

    const stored = await repository.count();
    expect(stored).toBe(result.savedEntryIds.length);
    expect(adapter.calls).toEqual(['step-1', 'step-2']);

    await repository.close();
  });

  it('stops after budget is exceeded and returns partial results', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubResearchAdapter();
    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: (() => {
        const timestamps = [
          new Date('2026-04-20T14:00:00.000Z'),
          new Date('2026-04-20T14:00:01.000Z'),
          new Date('2026-04-20T14:00:02.000Z'),
          new Date('2026-04-20T14:00:03.000Z'),
        ];
        let index = 0;
        return () => timestamps[Math.min(index++, timestamps.length - 1)];
      })(),
    });

    const task: ResearchTask = {
      id: 'task-research-2',
      gapId: 'gap-2',
      gapType: 'structural_gap',
      title: '调研：补齐 ops 知识链',
      objective: '补 ops 缺口。',
      scope: {
        topic: 'ops knowledge chain',
        domain: 'ops',
        boundaries: ['只做 ops'],
        acquisitionMethods: ['document_read', 'paper_parse'],
      },
      expectedKnowledgeTypes: ['fact', 'methodology'],
      strategy: {
        steps: [
          {
            id: 'step-1',
            method: 'web_search',
            query: 'ops fundamentals',
            rationale: '先找综述',
          },
          {
            id: 'step-2',
            method: 'paper_parse',
            query: 'ops best practices',
            rationale: '再补深度资料',
          },
        ],
        searchQueries: ['ops fundamentals'],
      },
      completionCriteria: ['至少一条知识'],
      budget: {
        maxDurationMs: 5_000,
        maxApiCalls: 2,
      },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: new Date('2026-04-20T13:55:00.000Z'),
    };

    const result = await executor.execute(task);
    expect(result.status).toBe('budget_exceeded');
    expect(result.completedStepIds).toEqual(['step-1']);
    expect(result.skippedStepIds).toEqual(['step-2']);
    expect(result.terminationReason).toContain('预算');
    expect(result.artifacts).toHaveLength(1);
    expect(result.consumedBudget.apiCalls).toBe(2);

    await repository.close();
  });
});

describe('ResearchScheduler', () => {
  it('scores tasks by impact × urgency and schedules without抢占用户任务资源', () => {
    const now = new Date('2026-04-20T15:00:00.000Z');
    const scheduler = new ResearchScheduler({ now: () => now });

    const tasks: ResearchTask[] = [
      {
        id: 'task-high',
        gapId: 'gap-1',
        gapType: 'frequency_blind_spot',
        title: '高优任务',
        objective: '...',
        scope: { topic: 'topic-a', boundaries: ['a'], acquisitionMethods: ['web_search'] },
        expectedKnowledgeTypes: ['fact'],
        strategy: { steps: [], searchQueries: [] },
        completionCriteria: ['done'],
        budget: { maxDurationMs: 1000, maxApiCalls: 3 },
        priority: 'high',
        impactScore: 3,
        urgencyScore: 3,
        blocking: true,
        createdAt: new Date('2026-04-20T14:00:00.000Z'),
      },
      {
        id: 'task-deferred',
        gapId: 'gap-2',
        gapType: 'structural_gap',
        title: '延后任务',
        objective: '...',
        scope: { topic: 'topic-b', boundaries: ['b'], acquisitionMethods: ['document_read'] },
        expectedKnowledgeTypes: ['experience'],
        strategy: { steps: [], searchQueries: [] },
        completionCriteria: ['done'],
        budget: { maxDurationMs: 1000, maxApiCalls: 3 },
        priority: 'medium',
        impactScore: 2,
        urgencyScore: 2,
        blocking: false,
        createdAt: new Date('2026-04-20T14:10:00.000Z'),
        scheduleAfter: new Date('2026-04-20T16:00:00.000Z'),
      },
      {
        id: 'task-low',
        gapId: 'gap-3',
        gapType: 'frequency_blind_spot',
        title: '低优任务',
        objective: '...',
        scope: { topic: 'topic-c', boundaries: ['c'], acquisitionMethods: ['document_read'] },
        expectedKnowledgeTypes: ['fact'],
        strategy: { steps: [], searchQueries: [] },
        completionCriteria: ['done'],
        budget: { maxDurationMs: 1000, maxApiCalls: 3 },
        priority: 'low',
        impactScore: 1,
        urgencyScore: 1,
        blocking: false,
        createdAt: new Date('2026-04-20T14:20:00.000Z'),
      },
    ];

    const normalDecision = scheduler.schedule(tasks, {
      maxConcurrentResearchTasks: 1,
      frequencyMs: 30 * 60 * 1000,
      silentMode: false,
      userTaskActive: false,
    });

    expect(normalDecision.runnable.map((task) => task.id)).toEqual(['task-high']);
    expect(normalDecision.deferred.map((task) => task.id)).toEqual(['task-deferred']);
    expect(normalDecision.skipped.map((task) => task.id)).toEqual(['task-low']);
    expect(normalDecision.scores[0]).toMatchObject({
      taskId: 'task-high',
      score: 44,
    });
    expect(normalDecision.nextRunAt).toEqual(new Date('2026-04-20T15:30:00.000Z'));

    const userBusyDecision = scheduler.schedule(tasks, {
      maxConcurrentResearchTasks: 2,
      frequencyMs: 15 * 60 * 1000,
      silentMode: false,
      userTaskActive: true,
    });
    expect(userBusyDecision.runnable).toEqual([]);
    expect(userBusyDecision.skipped.map((task) => task.id)).toEqual(['task-high', 'task-low']);
    expect(userBusyDecision.userTaskActive).toBe(true);

    const silentDecision = scheduler.schedule(tasks, {
      maxConcurrentResearchTasks: 2,
      frequencyMs: 10 * 60 * 1000,
      silentMode: true,
      userTaskActive: false,
    });
    expect(silentDecision.runnable).toEqual([]);
    expect(silentDecision.skipped.map((task) => task.id)).toEqual(['task-high', 'task-deferred', 'task-low']);
    expect(silentDecision.silentMode).toBe(true);
  });
});
