/**
 * FR-D02 End-to-End Integration Tests
 *
 * Validates the complete research pipeline:
 *   Gap Detection → Task Generation → Research Execution → Knowledge Extraction → Repository Persistence
 *
 * AC coverage:
 *   AC1: Task contains objective, scope, expected knowledge types, search strategy, completion criteria
 *   AC2: Search strategy defines information acquisition methods
 *   AC3: Research execution → knowledge extraction → repository persistence (full loop)
 *   AC4: Budget exceeded → early termination
 *   AC5: Re-research operation
 *   AC6: Task detail view
 *
 * Also covers FR-D03 AC1: Priority calculation based on impact and urgency
 */

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
} from '../../src/index.js';
import { KnowledgeRepository, SQLiteProvider } from '../../src/repository/index.js';

// ─── Shared Helpers ──────────────────────────────────────────────────────────

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'test://research-e2e',
  timestamp: new Date('2026-04-30T10:00:00.000Z'),
  agent: 'test-agent',
};

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = overrides.createdAt ?? new Date('2026-04-30T10:00:00.000Z');
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

/** Stub adapter that returns predictable artifacts for each step */
class StubResearchAdapter implements ResearchExecutorAdapter {
  readonly calls: Array<{ stepId: string; taskId: string; method: string }> = [];

  async execute(step: ResearchStep, task: ResearchTask) {
    this.calls.push({ stepId: step.id, taskId: task.id, method: step.method });
    return {
      apiCallsUsed: step.method === 'web_search' ? 2 : 1,
      artifacts: [
        {
          id: `${task.id}-${step.id}-art`,
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

/** Adapter that consumes a lot of API calls to trigger budget limits */
class BudgetBustingAdapter implements ResearchExecutorAdapter {
  callCount = 0;

  constructor(private readonly apiCallsPerStep: number) {}

  async execute(step: ResearchStep, task: ResearchTask) {
    this.callCount++;
    return {
      apiCallsUsed: this.apiCallsPerStep,
      artifacts: [
        {
          id: `budget-art-${this.callCount}`,
          method: step.method,
          title: `Budget test result ${this.callCount}`,
          content: `Research content about ${task.scope.topic}. Facts for extraction.`,
          reference: `https://example.com/budget/${this.callCount}`,
        },
      ],
    };
  }
}

function makeTimestampSequence(base: string, count: number): Date[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(`${base}${String(i).padStart(2, '0')}.000Z`)
  );
}

function makeTask(overrides: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: 'task-e2e-1',
    gapId: 'gap-e2e-1',
    gapType: 'frequency_blind_spot',
    title: '调研：KIVO 知识迁移',
    objective: '补齐 KIVO 知识迁移相关知识盲区。',
    scope: {
      topic: 'KIVO knowledge migration',
      boundaries: ['聚焦迁移流程'],
      acquisitionMethods: ['web_search', 'document_read'],
    },
    expectedKnowledgeTypes: ['fact', 'methodology', 'experience'],
    strategy: {
      steps: [
        {
          id: 'step-1',
          method: 'web_search',
          query: 'KIVO knowledge migration',
          rationale: '搜索迁移最佳实践',
          limit: 3,
        },
        {
          id: 'step-2',
          method: 'document_read',
          query: 'KIVO migration docs',
          rationale: '读取内部文档',
          limit: 2,
        },
      ],
      searchQueries: ['KIVO knowledge migration'],
    },
    completionCriteria: ['形成可检索知识条目', '覆盖迁移流程关键步骤'],
    budget: { maxDurationMs: 60_000, maxApiCalls: 20 },
    priority: 'high',
    impactScore: 3,
    urgencyScore: 3,
    blocking: true,
    createdAt: new Date('2026-04-30T12:00:00.000Z'),
    ...overrides,
  };
}

// ─── Test 1: AC1 — Task Generation from KnowledgeGap ────────────────────────

describe('FR-D02 AC1: Gap → ResearchTask generation', () => {
  it('generates tasks with objective, scope, expected knowledge types, strategy, and completion criteria', () => {
    // Set up gap detector and record enough misses to trigger a high-priority gap
    const detector = new GapDetector({
      now: () => new Date('2026-04-30T12:00:00.000Z'),
      idGenerator: (() => {
        let seq = 0;
        return () => `gap-gen-${++seq}`;
      })(),
    });

    for (let i = 0; i < 5; i++) {
      detector.recordQueryMiss('KIVO knowledge migration best practices');
    }

    const entries = [
      makeEntry({ id: 'ml-fact', domain: 'machine-learning', type: 'fact' }),
      makeEntry({ id: 'ml-method', domain: 'machine-learning', type: 'methodology' }),
    ];
    const links = [{ sourceId: 'ml-fact', targetId: 'ml-method' }];

    const gapResult = detector.detect(entries, links);
    expect(gapResult.gaps.length).toBeGreaterThanOrEqual(1);

    // Generate research tasks from detected gaps
    const generator = new ResearchTaskGenerator({
      now: () => new Date('2026-04-30T12:05:00.000Z'),
      idGenerator: (() => {
        let seq = 0;
        return () => `task-gen-${++seq}`;
      })(),
    });

    const tasks = generator.generate(gapResult);
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    const task = tasks[0];

    // AC1: objective
    expect(task.objective).toBeTruthy();
    expect(task.objective.length).toBeGreaterThan(10);

    // AC1: scope with topic and boundaries
    expect(task.scope).toBeDefined();
    expect(task.scope.topic).toBeTruthy();
    expect(task.scope.boundaries.length).toBeGreaterThanOrEqual(1);

    // AC1: expected knowledge types
    expect(task.expectedKnowledgeTypes.length).toBeGreaterThanOrEqual(1);

    // AC1: strategy with steps
    expect(task.strategy).toBeDefined();
    expect(task.strategy.steps.length).toBeGreaterThanOrEqual(1);

    // AC1: completion criteria
    expect(task.completionCriteria).toBeDefined();
    expect(task.completionCriteria.length).toBeGreaterThanOrEqual(1);

    // Verify task has required structural fields
    expect(task.id).toBeTruthy();
    expect(task.gapId).toBeTruthy();
    expect(task.title).toBeTruthy();
    expect(task.budget).toBeDefined();
    expect(task.budget.maxDurationMs).toBeGreaterThan(0);
    expect(task.budget.maxApiCalls).toBeGreaterThan(0);
    expect(task.priority).toBeTruthy();
    expect(task.createdAt).toBeInstanceOf(Date);
  });
});

// ─── Test 2: AC2 — Search Strategy Defines Acquisition Methods ──────────────

describe('FR-D02 AC2: Search strategy acquisition methods', () => {
  it('generated tasks include acquisition methods matching gap type', () => {
    const detector = new GapDetector({
      now: () => new Date('2026-04-30T12:00:00.000Z'),
      idGenerator: (() => {
        let seq = 0;
        return () => `gap-acq-${++seq}`;
      })(),
    });

    // Frequency gap → should include web_search
    for (let i = 0; i < 5; i++) {
      detector.recordQueryMiss('OpenClaw plugin development guide');
    }

    // Structural gap → should include document_read
    const entries = [
      makeEntry({ id: 'ops-exp', domain: 'operations', type: 'experience' }),
    ];

    const gapResult = detector.detect(entries);
    const generator = new ResearchTaskGenerator({
      now: () => new Date('2026-04-30T12:05:00.000Z'),
      idGenerator: (() => {
        let seq = 0;
        return () => `task-acq-${++seq}`;
      })(),
    });

    const tasks = generator.generate(gapResult);
    expect(tasks.length).toBeGreaterThanOrEqual(2);

    // Frequency blind spot task should have web_search in its strategy
    const freqTask = tasks.find((t) => t.gapType === 'frequency_blind_spot');
    expect(freqTask).toBeDefined();
    expect(freqTask!.scope.acquisitionMethods).toContain('web_search');
    expect(freqTask!.strategy.steps.some((s) => s.method === 'web_search')).toBe(true);

    // Each step should have query and rationale
    for (const step of freqTask!.strategy.steps) {
      expect(step.query).toBeTruthy();
      expect(step.rationale).toBeTruthy();
      expect(step.method).toBeTruthy();
    }

    // Structural gap task should have document_read in its strategy
    const structTask = tasks.find((t) => t.gapType === 'structural_gap');
    expect(structTask).toBeDefined();
    expect(structTask!.scope.acquisitionMethods).toContain('document_read');
    expect(structTask!.strategy.steps.some((s) => s.method === 'document_read')).toBe(true);
  });
});

// ─── Test 3: AC4 — Budget Exceeded → Early Termination ──────────────────────

describe('FR-D02 AC4: Resource budget enforcement', () => {
  it('terminates research when API call budget is exceeded', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new BudgetBustingAdapter(15); // 15 calls per step, budget is 10

    const timestamps = makeTimestampSequence('2026-04-30T13:00:', 20);
    let idx = 0;

    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: () => timestamps[Math.min(idx++, timestamps.length - 1)],
    });

    const task = makeTask({
      id: 'task-budget-api',
      budget: { maxDurationMs: 600_000, maxApiCalls: 10 },
      strategy: {
        steps: [
          { id: 'step-1', method: 'web_search', query: 'test', rationale: 'test', limit: 3 },
          { id: 'step-2', method: 'document_read', query: 'test', rationale: 'test', limit: 2 },
          { id: 'step-3', method: 'web_search', query: 'test2', rationale: 'test2', limit: 3 },
        ],
        searchQueries: ['test'],
      },
    });

    const result = await executor.execute(task);

    expect(result.status).toBe('budget_exceeded');
    expect(result.terminationReason).toBeTruthy();
    expect(result.consumedBudget.apiCalls).toBeGreaterThanOrEqual(10);

    // First step should complete, remaining should be skipped
    expect(result.completedStepIds).toContain('step-1');
    expect(result.skippedStepIds.length).toBeGreaterThanOrEqual(1);

    // Adapter should not have been called for all steps
    expect(adapter.callCount).toBeLessThan(3);
  });

  it('terminates research when time budget is exceeded', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubResearchAdapter();

    // Timestamps that jump far ahead to exceed duration budget
    const timestamps = [
      new Date('2026-04-30T13:00:00.000Z'), // start
      new Date('2026-04-30T13:00:01.000Z'), // step-1 budget check
      new Date('2026-04-30T13:00:02.000Z'), // step-1 execute
      new Date('2026-04-30T13:00:03.000Z'), // step-1 timeline
      new Date('2026-04-30T14:00:00.000Z'), // step-2 budget check — 1 hour later, exceeds 5s budget
      new Date('2026-04-30T14:00:01.000Z'),
      new Date('2026-04-30T14:00:02.000Z'),
      new Date('2026-04-30T14:00:03.000Z'),
      new Date('2026-04-30T14:00:04.000Z'),
      new Date('2026-04-30T14:00:05.000Z'),
    ];
    let idx = 0;

    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: () => timestamps[Math.min(idx++, timestamps.length - 1)],
    });

    const task = makeTask({
      id: 'task-budget-time',
      budget: { maxDurationMs: 5_000, maxApiCalls: 100 }, // 5 second time budget
    });

    const result = await executor.execute(task);

    expect(result.status).toBe('budget_exceeded');
    expect(result.skippedStepIds.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Test 4: FR-D03 AC1 — Priority Calculation ─────────────────────────────

describe('FR-D03 AC1: Priority calculation based on impact and urgency', () => {
  it('scheduler scores tasks by priority, impact, urgency, and blocking status', () => {
    const scheduler = new ResearchScheduler({
      now: () => new Date('2026-04-30T14:00:00.000Z'),
    });

    const highTask = makeTask({
      id: 'task-high',
      priority: 'high',
      impactScore: 5,
      urgencyScore: 4,
      blocking: true,
    });

    const mediumTask = makeTask({
      id: 'task-medium',
      priority: 'medium',
      impactScore: 3,
      urgencyScore: 2,
      blocking: false,
    });

    const lowTask = makeTask({
      id: 'task-low',
      priority: 'low',
      impactScore: 1,
      urgencyScore: 1,
      blocking: false,
    });

    const decision = scheduler.schedule([lowTask, highTask, mediumTask], {
      maxConcurrentResearchTasks: 2,
      frequencyMs: 30 * 60 * 1000,
      silentMode: false,
      userTaskActive: false,
    });

    // High priority task should be first
    expect(decision.runnable[0].id).toBe('task-high');
    expect(decision.runnable).toHaveLength(2);

    // Scores should reflect impact * urgency + base + blocking bonus
    const highScore = decision.scores.find((s) => s.taskId === 'task-high');
    const lowScore = decision.scores.find((s) => s.taskId === 'task-low');
    expect(highScore).toBeDefined();
    expect(lowScore).toBeDefined();
    expect(highScore!.score).toBeGreaterThan(lowScore!.score);

    // High task: base(30) + impact*urgency(5*4=20) + blocking(5) = 55
    expect(highScore!.score).toBe(55);
    // Low task: base(10) + impact*urgency(1*1=1) + blocking(0) = 11
    expect(lowScore!.score).toBe(11);
  });

  it('defers tasks with scheduleAfter in the future', () => {
    const scheduler = new ResearchScheduler({
      now: () => new Date('2026-04-30T14:00:00.000Z'),
    });

    const deferredTask = makeTask({
      id: 'task-deferred',
      scheduleAfter: new Date('2026-04-30T15:00:00.000Z'), // 1 hour in the future
    });

    const decision = scheduler.schedule([deferredTask], {
      maxConcurrentResearchTasks: 2,
      frequencyMs: 30 * 60 * 1000,
      silentMode: false,
      userTaskActive: false,
    });

    expect(decision.runnable).toHaveLength(0);
    expect(decision.deferred).toHaveLength(1);
    expect(decision.deferred[0].id).toBe('task-deferred');
  });
});

// ─── Test 5: AC3 — Full Loop: Execute → Extract → Persist ──────────────────

describe('FR-D02 AC3: Research execution → knowledge extraction → repository persistence', () => {
  it('executes research steps, extracts knowledge entries, and persists to repository', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubResearchAdapter();

    const timestamps = makeTimestampSequence('2026-04-30T15:00:', 20);
    let idx = 0;

    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: () => timestamps[Math.min(idx++, timestamps.length - 1)],
    });

    const task = makeTask({ id: 'task-full-loop' });
    const result = await executor.execute(task);

    // Execution completed successfully
    expect(result.status).toBe('completed');
    expect(result.taskId).toBe('task-full-loop');

    // All steps executed
    expect(result.completedStepIds).toEqual(['step-1', 'step-2']);
    expect(result.skippedStepIds).toEqual([]);

    // Artifacts collected from both steps
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts[0].method).toBe('web_search');
    expect(result.artifacts[1].method).toBe('document_read');

    // Knowledge entries extracted from artifacts
    expect(result.extractedEntries.length).toBeGreaterThanOrEqual(1);

    // Entries persisted to repository
    expect(result.savedEntryIds.length).toBeGreaterThanOrEqual(1);
    for (const entryId of result.savedEntryIds) {
      const saved = await repository.findById(entryId);
      expect(saved).not.toBeNull();
      expect(saved!.source.type).toBe('research');
    }

    // Budget consumed correctly
    expect(result.consumedBudget.apiCalls).toBe(3); // web_search=2 + document_read=1
    expect(result.consumedBudget.elapsedMs).toBeGreaterThan(0);

    // Summary generated
    expect(result.summary).toContain('调研任务');
    expect(result.summary).toContain('资料');

    // Adapter was called for each step
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0]).toMatchObject({ stepId: 'step-1', method: 'web_search' });
    expect(adapter.calls[1]).toMatchObject({ stepId: 'step-2', method: 'document_read' });
  });
});

// ─── Test 6: AC5 — Re-research Operation ────────────────────────────────────

describe('FR-D02 AC5: Re-research operation', () => {
  it('clears previous results and re-executes the same task', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubResearchAdapter();

    const timestamps = makeTimestampSequence('2026-04-30T16:00:', 30);
    let idx = 0;

    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: () => timestamps[Math.min(idx++, timestamps.length - 1)],
    });

    const task = makeTask({ id: 'task-reresearch' });

    // First execution
    const result1 = await executor.execute(task);
    expect(result1.status).toBe('completed');
    expect(result1.artifacts).toHaveLength(2);
    const firstCallCount = adapter.calls.length;

    // Re-execute
    const result2 = await executor.reExecute(task);
    expect(result2.status).toBe('completed');
    expect(result2.artifacts).toHaveLength(2);

    // Adapter was called again for all steps
    expect(adapter.calls.length).toBe(firstCallCount + 2);

    // Detail view reflects the latest execution
    const detail = executor.getTaskDetail(task.id);
    expect(detail).not.toBeNull();
    expect(detail!.result.taskId).toBe('task-reresearch');
    expect(detail!.result.startedAt.getTime()).toBeGreaterThan(result1.startedAt.getTime());
  });
});

// ─── Test 7: AC6 — Task Detail View ─────────────────────────────────────────

describe('FR-D02 AC6: Task detail view', () => {
  it('provides comprehensive detail with steps, artifacts, timeline, and extracted entries', async () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubResearchAdapter();

    const timestamps = makeTimestampSequence('2026-04-30T17:00:', 20);
    let idx = 0;

    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: () => timestamps[Math.min(idx++, timestamps.length - 1)],
    });

    const task = makeTask({ id: 'task-detail-view' });
    await executor.execute(task);

    const detail = executor.getTaskDetail('task-detail-view');
    expect(detail).not.toBeNull();

    // Task reference
    expect(detail!.task.id).toBe('task-detail-view');
    expect(detail!.task.title).toBe('调研：KIVO 知识迁移');

    // Result
    expect(detail!.result.status).toBe('completed');
    expect(detail!.result.completedStepIds).toEqual(['step-1', 'step-2']);

    // Step details
    expect(detail!.steps).toHaveLength(2);
    expect(detail!.steps[0]).toMatchObject({
      step: expect.objectContaining({ id: 'step-1', method: 'web_search' }),
      status: 'completed',
    });
    expect(detail!.steps[0].artifacts.length).toBeGreaterThanOrEqual(1);
    expect(detail!.steps[0].apiCallsUsed).toBeGreaterThan(0);

    expect(detail!.steps[1]).toMatchObject({
      step: expect.objectContaining({ id: 'step-2', method: 'document_read' }),
      status: 'completed',
    });

    // Artifacts
    expect(detail!.artifacts).toHaveLength(2);

    // Extracted entry IDs
    expect(detail!.extractedEntryIds.length).toBeGreaterThanOrEqual(1);

    // Timeline events
    expect(detail!.timeline.length).toBeGreaterThanOrEqual(3); // started + 2 steps at minimum
    expect(detail!.timeline[0].event).toBe('task_started');
    expect(detail!.timeline[detail!.timeline.length - 1].event).toBe('task_completed');

    // Non-existent task returns null
    expect(executor.getTaskDetail('non-existent')).toBeNull();
  });
});

// ─── Test 8: Full Pipeline — Gap Detection → Task Gen → Execute → Persist ──

describe('FR-D02 Full Pipeline: end-to-end from gap detection to knowledge persistence', () => {
  it('runs the complete research pipeline from gap detection through knowledge storage', async () => {
    // Phase 1: Detect gaps
    const detector = new GapDetector({
      now: () => new Date('2026-04-30T10:00:00.000Z'),
      idGenerator: (() => {
        let seq = 0;
        return () => `e2e-gap-${++seq}`;
      })(),
    });

    // Record enough misses to create a high-priority frequency gap
    for (let i = 0; i < 6; i++) {
      detector.recordQueryMiss('How to configure KIVO embedding pipeline');
    }

    const entries = [
      makeEntry({ id: 'embed-fact', domain: 'embedding', type: 'fact' }),
    ];

    const gapResult = detector.detect(entries);
    expect(gapResult.gaps.length).toBeGreaterThanOrEqual(1);
    expect(gapResult.suggestions.length).toBeGreaterThanOrEqual(1);

    // Phase 2: Generate research tasks
    const generator = new ResearchTaskGenerator({
      now: () => new Date('2026-04-30T10:05:00.000Z'),
      idGenerator: (() => {
        let seq = 0;
        return () => `e2e-task-${++seq}`;
      })(),
    });

    const tasks = generator.generate(gapResult);
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    // Phase 3: Schedule (verify the task would be selected)
    const scheduler = new ResearchScheduler({
      now: () => new Date('2026-04-30T10:10:00.000Z'),
    });

    const decision = scheduler.schedule(tasks, {
      maxConcurrentResearchTasks: 3,
      frequencyMs: 30 * 60 * 1000,
      silentMode: false,
      userTaskActive: false,
    });

    expect(decision.runnable.length).toBeGreaterThanOrEqual(1);

    // Phase 4: Execute the top-priority task
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const adapter = new StubResearchAdapter();

    const timestamps = makeTimestampSequence('2026-04-30T10:15:', 30);
    let idx = 0;

    const executor = new ResearchExecutor({
      adapter,
      repository,
      now: () => timestamps[Math.min(idx++, timestamps.length - 1)],
    });

    const topTask = decision.runnable[0];
    const result = await executor.execute(topTask);

    // Phase 5: Verify results
    expect(result.status).toBe('completed');
    expect(result.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(result.extractedEntries.length).toBeGreaterThanOrEqual(1);
    expect(result.savedEntryIds.length).toBeGreaterThanOrEqual(1);

    // Phase 6: Verify persistence — entries are in the repository
    for (const entryId of result.savedEntryIds) {
      const persisted = await repository.findById(entryId);
      expect(persisted).not.toBeNull();
      expect(persisted!.source.type).toBe('research');
    }

    // Phase 7: Verify detail view works for the executed task
    const detail = executor.getTaskDetail(topTask.id);
    expect(detail).not.toBeNull();
    expect(detail!.result.status).toBe('completed');
    expect(detail!.timeline.length).toBeGreaterThanOrEqual(3);

    // The full pipeline is verified:
    // Gap Detection ✓ → Task Generation ✓ → Scheduling ✓ → Execution ✓ → Extraction ✓ → Persistence ✓
  });
});
