import { describe, expect, it } from 'vitest';
import {
  GapDetector,
  ResearchExecutor,
  ResearchTaskGenerator,
  type KnowledgeEntry,
  type KnowledgeSource,
  type ResearchExecutorAdapter,
  type ResearchStep,
  type ResearchTask,
  type ResearchArtifact,
} from '../src/index.js';
import { KnowledgeRepository, SQLiteProvider } from '../src/repository/index.js';

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'test://e2e-d02',
  timestamp: new Date('2026-05-01T10:00:00.000Z'),
};

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = overrides.createdAt ?? new Date('2026-05-01T10:00:00.000Z');
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
    updatedAt: new Date(createdAt.getTime()),
    version: 1,
    ...overrides,
  };
}

class StubAdapter implements ResearchExecutorAdapter {
  callCount = 0;
  readonly calls: { stepId: string; method: string; query: string }[] = [];

  async execute(step: ResearchStep, task: ResearchTask) {
    this.callCount++;
    this.calls.push({ stepId: step.id, method: step.method, query: step.query });
    return {
      apiCallsUsed: step.method === 'web_search' ? 2 : 1,
      artifacts: [
        {
          id: `art-${task.id}-${step.id}-${this.callCount}`,
          method: step.method,
          title: `${task.title} / ${step.method}`,
          content: `Knowledge about ${task.scope.topic}. Facts and methodology for durable extraction.`,
          reference: `https://example.com/${step.id}`,
          metadata: { query: step.query },
        },
      ],
    };
  }
}

function makeTimestamps(base: string, count: number): (() => Date) {
  const ts = Array.from({ length: count }, (_, i) => {
    const d = new Date(base);
    d.setSeconds(d.getSeconds() + i);
    return d;
  });
  let idx = 0;
  return () => ts[Math.min(idx++, ts.length - 1)];
}

// ─── AC1: 调研任务包含目标、范围、预期知识类型、搜索策略、完成标准 ───
describe('FR-D02 AC1: research task structure', () => {
  it('generated task contains objective, scope, expectedKnowledgeTypes, strategy, completionCriteria', () => {
    const detector = new GapDetector({
      now: () => new Date('2026-05-01T12:00:00.000Z'),
      idGenerator: (() => { let s = 0; return () => `gap-${++s}`; })(),
    });

    for (let i = 0; i < 5; i++) detector.recordQueryMiss('Kubernetes pod scheduling');

    const entries = [
      makeEntry({ id: 'k8s-fact', domain: 'k8s', type: 'fact' }),
      makeEntry({ id: 'k8s-method', domain: 'k8s', type: 'methodology' }),
    ];

    const gapResult = detector.detect(entries, [
      { sourceId: 'k8s-fact', targetId: 'k8s-method' },
    ]);
    expect(gapResult.gaps.length).toBeGreaterThan(0);

    const generator = new ResearchTaskGenerator({
      now: () => new Date('2026-05-01T12:05:00.000Z'),
      idGenerator: (() => { let s = 0; return () => `task-${++s}`; })(),
    });

    const tasks = generator.generate(gapResult);
    expect(tasks.length).toBeGreaterThan(0);

    const task = tasks[0];
    expect(task.objective).toBeTruthy();
    expect(task.scope).toBeDefined();
    expect(task.scope.topic).toBeTruthy();
    expect(task.scope.boundaries.length).toBeGreaterThan(0);
    expect(task.expectedKnowledgeTypes.length).toBeGreaterThan(0);
    expect(task.strategy).toBeDefined();
    expect(task.strategy.steps.length).toBeGreaterThan(0);
    expect(task.strategy.searchQueries.length).toBeGreaterThan(0);
    expect(task.completionCriteria.length).toBeGreaterThan(0);
    expect(task.budget).toBeDefined();
    expect(task.budget.maxDurationMs).toBeGreaterThan(0);
    expect(task.budget.maxApiCalls).toBeGreaterThan(0);
  });
});

// ─── AC2: 调研任务定义包含信息获取方式 ───
describe('FR-D02 AC2: acquisition methods in task definition', () => {
  it('task scope.acquisitionMethods and strategy steps specify acquisition methods', () => {
    const detector = new GapDetector({
      now: () => new Date('2026-05-01T12:00:00.000Z'),
      idGenerator: (() => { let s = 0; return () => `gap-${++s}`; })(),
    });

    for (let i = 0; i < 4; i++) detector.recordQueryMiss('React server components');

    const entries = [
      makeEntry({ id: 'react-fact', domain: 'react', type: 'fact' }),
    ];

    const gapResult = detector.detect(entries, []);
    const generator = new ResearchTaskGenerator({
      now: () => new Date('2026-05-01T12:05:00.000Z'),
      idGenerator: (() => { let s = 0; return () => `task-${++s}`; })(),
    });

    const tasks = generator.generate(gapResult);

    for (const task of tasks) {
      expect(task.scope.acquisitionMethods.length).toBeGreaterThan(0);
      for (const method of task.scope.acquisitionMethods) {
        expect(['web_search', 'document_read', 'paper_parse']).toContain(method);
      }
      for (const step of task.strategy.steps) {
        expect(step.method).toBeTruthy();
        expect(['web_search', 'document_read', 'paper_parse']).toContain(step.method);
        expect(step.query).toBeTruthy();
        expect(step.rationale).toBeTruthy();
      }
    }
  });
});

// ─── AC3: 调研结果经知识提取后入库（闭环） ───
describe('FR-D02 AC3: research results extracted and persisted', () => {
  it('full loop: gap detection → task generation → execution → extraction → repository', async () => {
    const detector = new GapDetector({
      now: () => new Date('2026-05-01T12:00:00.000Z'),
      idGenerator: (() => { let s = 0; return () => `gap-${++s}`; })(),
    });

    for (let i = 0; i < 5; i++) detector.recordQueryMiss('GraphQL subscriptions');

    const entries = [
      makeEntry({ id: 'gql-fact', domain: 'graphql', type: 'fact' }),
      makeEntry({ id: 'gql-method', domain: 'graphql', type: 'methodology' }),
    ];

    const gapResult = detector.detect(entries, [
      { sourceId: 'gql-fact', targetId: 'gql-method' },
    ]);

    const generator = new ResearchTaskGenerator({
      now: () => new Date('2026-05-01T12:05:00.000Z'),
      idGenerator: (() => { let s = 0; return () => `task-${++s}`; })(),
    });

    const tasks = generator.generate(gapResult);
    expect(tasks.length).toBeGreaterThan(0);

    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubAdapter();
    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: makeTimestamps('2026-05-01T13:00:00.000Z', 30),
    });

    const task = tasks[0];
    const result = await executor.execute(task);

    expect(result.status).toBe('completed');
    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.extractedEntries.length).toBeGreaterThan(0);
    expect(result.savedEntryIds.length).toBe(result.extractedEntries.length);

    const storedCount = await repository.count();
    expect(storedCount).toBe(result.savedEntryIds.length);

    for (const entryId of result.savedEntryIds) {
      const entry = await repository.findById(entryId);
      expect(entry).not.toBeNull();
      expect(entry!.source.type).toBe('research');
    }

    await repository.close();
  });
});

// ─── AC4: 资源预算超限自动终止并报告部分结果 ───
describe('FR-D02 AC4: budget exceeded terminates and reports partial results', () => {
  it('stops execution when apiCalls budget exceeded, returns partial results', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);

    const heavyAdapter: ResearchExecutorAdapter = {
      async execute(step: ResearchStep, task: ResearchTask) {
        return {
          apiCallsUsed: 10,
          artifacts: [{
            id: `art-heavy-${step.id}`,
            method: step.method,
            title: `Heavy result for ${step.query}`,
            content: `Knowledge about ${task.scope.topic}. Facts and methodology.`,
            reference: `https://example.com/${step.id}`,
          }],
        };
      },
    };

    const executor = new ResearchExecutor({
      adapter: heavyAdapter,
      repository,
      now: makeTimestamps('2026-05-01T14:00:00.000Z', 30),
    });

    const task: ResearchTask = {
      id: 'task-budget',
      gapId: 'gap-budget',
      gapType: 'frequency_blind_spot',
      title: '调研：budget test',
      objective: 'Test budget enforcement.',
      scope: {
        topic: 'budget enforcement',
        boundaries: ['test only'],
        acquisitionMethods: ['web_search', 'document_read'],
      },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [
          { id: 's1', method: 'web_search', query: 'budget q1', rationale: 'first', limit: 3 },
          { id: 's2', method: 'document_read', query: 'budget q2', rationale: 'second', limit: 2 },
          { id: 's3', method: 'web_search', query: 'budget q3', rationale: 'third', limit: 2 },
        ],
        searchQueries: ['budget'],
      },
      completionCriteria: ['at least one entry'],
      budget: { maxDurationMs: 600_000, maxApiCalls: 8 },
      priority: 'high',
      impactScore: 3,
      urgencyScore: 3,
      blocking: true,
      createdAt: new Date('2026-05-01T13:55:00.000Z'),
    };

    const result = await executor.execute(task);

    expect(result.status).toBe('budget_exceeded');
    expect(result.completedStepIds.length).toBeGreaterThanOrEqual(1);
    expect(result.skippedStepIds.length).toBeGreaterThanOrEqual(1);
    expect(result.terminationReason).toBeTruthy();
    expect(result.terminationReason).toContain('预算');
    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.summary).toContain('产出');

    await repository.close();
  });

  it('stops execution when duration budget exceeded', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubAdapter();

    let callIdx = 0;
    const timestamps = [
      new Date('2026-05-01T14:00:00.000Z'),
      new Date('2026-05-01T14:00:01.000Z'),
      new Date('2026-05-01T14:10:00.000Z'), // 10 min jump — exceeds 5s budget
      new Date('2026-05-01T14:10:01.000Z'),
      new Date('2026-05-01T14:10:02.000Z'),
      new Date('2026-05-01T14:10:03.000Z'),
    ];

    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: () => timestamps[Math.min(callIdx++, timestamps.length - 1)],
    });

    const task: ResearchTask = {
      id: 'task-duration',
      gapId: 'gap-dur',
      gapType: 'frequency_blind_spot',
      title: '调研：duration budget',
      objective: 'Test duration budget.',
      scope: {
        topic: 'duration test',
        boundaries: ['test'],
        acquisitionMethods: ['web_search'],
      },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [
          { id: 'd1', method: 'web_search', query: 'dur q1', rationale: 'first' },
          { id: 'd2', method: 'web_search', query: 'dur q2', rationale: 'second' },
        ],
        searchQueries: ['dur'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 5_000, maxApiCalls: 100 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: new Date('2026-05-01T13:59:00.000Z'),
    };

    const result = await executor.execute(task);
    expect(result.status).toBe('budget_exceeded');
    expect(result.skippedStepIds).toContain('d2');

    await repository.close();
  });
});

// ─── AC5: 已完成任务支持重新调研 ───
describe('FR-D02 AC5: re-research completed tasks', () => {
  it('reExecute clears old entries and produces fresh results', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubAdapter();
    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: makeTimestamps('2026-05-01T15:00:00.000Z', 40),
    });

    const task: ResearchTask = {
      id: 'task-rerun',
      gapId: 'gap-rerun',
      gapType: 'frequency_blind_spot',
      title: '调研：rerun test',
      objective: 'Test re-research.',
      scope: {
        topic: 'rerun topic',
        boundaries: ['test'],
        acquisitionMethods: ['web_search'],
      },
      expectedKnowledgeTypes: ['fact', 'methodology'],
      strategy: {
        steps: [
          { id: 'r1', method: 'web_search', query: 'rerun q1', rationale: 'search' },
        ],
        searchQueries: ['rerun'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 20 },
      priority: 'high',
      impactScore: 3,
      urgencyScore: 3,
      blocking: true,
      createdAt: new Date('2026-05-01T14:55:00.000Z'),
    };

    const result1 = await executor.execute(task);
    expect(result1.status).toBe('completed');
    const firstSavedIds = [...result1.savedEntryIds];
    const countAfterFirst = await repository.count();
    expect(countAfterFirst).toBeGreaterThan(0);

    const result2 = await executor.reExecute(task);
    expect(result2.status).toBe('completed');
    expect(result2.artifacts.length).toBeGreaterThan(0);

    for (const oldId of firstSavedIds) {
      const old = await repository.findById(oldId);
      expect(old).toBeNull();
    }

    const countAfterRerun = await repository.count();
    expect(countAfterRerun).toBe(result2.savedEntryIds.length);

    await repository.close();
  });
});

// ─── AC6: 详情视图展示调研过程、中间产出、引用来源 ───
describe('FR-D02 AC6: detail view shows process, artifacts, sources', () => {
  it('getTaskDetail returns steps, artifacts, timeline, and extracted entry ids', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubAdapter();
    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: makeTimestamps('2026-05-01T16:00:00.000Z', 30),
    });

    const task: ResearchTask = {
      id: 'task-detail',
      gapId: 'gap-detail',
      gapType: 'frequency_blind_spot',
      title: '调研：detail view test',
      objective: 'Test detail view.',
      scope: {
        topic: 'detail topic',
        boundaries: ['test'],
        acquisitionMethods: ['web_search', 'document_read'],
      },
      expectedKnowledgeTypes: ['fact', 'methodology'],
      strategy: {
        steps: [
          { id: 'dv1', method: 'web_search', query: 'detail q1', rationale: 'search', limit: 3 },
          { id: 'dv2', method: 'document_read', query: 'detail q2', rationale: 'read', limit: 2 },
        ],
        searchQueries: ['detail'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 20 },
      priority: 'high',
      impactScore: 3,
      urgencyScore: 3,
      blocking: true,
      createdAt: new Date('2026-05-01T15:55:00.000Z'),
    };

    await executor.execute(task);
    const detail = executor.getTaskDetail(task.id);

    expect(detail).not.toBeNull();

    expect(detail!.task.id).toBe('task-detail');
    expect(detail!.task.title).toBe('调研：detail view test');

    expect(detail!.result.status).toBe('completed');
    expect(detail!.result.completedStepIds).toEqual(['dv1', 'dv2']);

    expect(detail!.steps).toHaveLength(2);
    expect(detail!.steps[0].step.id).toBe('dv1');
    expect(detail!.steps[0].status).toBe('completed');
    expect(detail!.steps[0].artifacts.length).toBeGreaterThan(0);
    expect(detail!.steps[0].apiCallsUsed).toBeGreaterThan(0);

    expect(detail!.artifacts.length).toBeGreaterThanOrEqual(2);
    for (const art of detail!.artifacts) {
      expect(art.reference).toBeTruthy();
      expect(art.content).toBeTruthy();
      expect(art.title).toBeTruthy();
    }

    expect(detail!.timeline.length).toBeGreaterThanOrEqual(3);
    const events = detail!.timeline.map((e) => e.event);
    expect(events).toContain('task_started');
    expect(events).toContain('task_completed');
    expect(events.filter((e) => e === 'step_started').length).toBe(2);
    expect(events.filter((e) => e === 'step_completed').length).toBe(2);

    for (const evt of detail!.timeline) {
      expect(evt.timestamp).toBeInstanceOf(Date);
    }

    expect(detail!.extractedEntryIds.length).toBeGreaterThanOrEqual(0);

    await repository.close();
  });

  it('returns null for unknown task id', () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubAdapter();
    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: () => new Date('2026-05-01T16:00:00.000Z'),
    });

    expect(executor.getTaskDetail('nonexistent')).toBeNull();
  });
});
