import { beforeEach, describe, expect, it } from 'vitest';
import { ResearchTaskGenerator } from '../research-task-generator.js';
import { ResearchExecutor, type ResearchExecutorAdapter } from '../research-executor.js';
import { ResearchScheduler } from '../research-scheduler.js';
import { GapDetector } from '../gap-detector.js';
import type { KnowledgeEntry, KnowledgeSource } from '../../types/index.js';
import type { KnowledgeRepository } from '../../repository/index.js';
import type {
  ResearchArtifact,
  ResearchStep,
  ResearchStepResult,
  ResearchTask,
} from '../research-task-types.js';
import type { GapDetectionResult, KnowledgeGap } from '../gap-detection-types.js';

// ── test helpers ────────────────────────────────────────────────────────

let idCounter = 0;
const nextId = () => `test-id-${++idCounter}`;

const fixedNow = () => new Date('2026-05-01T10:00:00.000Z');

function makeSource(ref: string): KnowledgeSource {
  return { type: 'document', reference: ref, timestamp: new Date('2026-04-20T09:00:00Z') };
}

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? nextId();
  return {
    id,
    type: 'fact',
    title: 'Test entry',
    content: 'Test content',
    summary: 'Test summary',
    source: makeSource(`doc://${id}`),
    confidence: 0.9,
    status: 'active',
    tags: ['test'],
    createdAt: new Date('2026-04-10T09:00:00Z'),
    updatedAt: new Date('2026-04-10T09:00:00Z'),
    version: 1,
    ...overrides,
  };
}

class MockRepository {
  readonly saved: KnowledgeEntry[] = [];
  readonly deleted: string[] = [];
  async save(entry: KnowledgeEntry): Promise<void> {
    this.saved.push(entry);
  }
  async delete(id: string): Promise<void> {
    this.deleted.push(id);
  }
}

function makeArtifact(id: string, method: ResearchArtifact['method'] = 'web_search'): ResearchArtifact {
  return {
    id,
    method,
    title: `Artifact ${id}`,
    content: `# Artifact ${id}\n\nSome research content about the topic.`,
    reference: `https://example.com/${id}`,
  };
}

function makeMockAdapter(
  results: Map<string, ResearchStepResult> = new Map(),
  delayMs = 0,
): ResearchExecutorAdapter {
  return {
    async execute(step: ResearchStep, _task: ResearchTask): Promise<ResearchStepResult> {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return results.get(step.id) ?? { artifacts: [], apiCallsUsed: 1 };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// AC1: 调研任务包含目标、范围、预期知识类型、搜索策略和完成标准
// ═══════════════════════════════════════════════════════════════════════

describe('FR-D02 AC1: research task structure', () => {
  let generator: ResearchTaskGenerator;

  beforeEach(() => {
    idCounter = 0;
    generator = new ResearchTaskGenerator({ now: fixedNow, idGenerator: nextId });
  });

  it('generates task with objective, scope, expectedKnowledgeTypes, strategy, completionCriteria from frequency gap', () => {
    const detector = new GapDetector({ now: fixedNow, idGenerator: nextId });
    for (let i = 0; i < 5; i++) detector.recordQueryMiss('kubernetes pod scheduling');
    const result = detector.detect([]);
    const tasks = generator.generate(result);

    expect(tasks.length).toBeGreaterThanOrEqual(1);
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

  it('generates task from structural gap with domain-specific scope', () => {
    const entries = [
      makeEntry({ domain: 'networking', type: 'fact' }),
    ];
    const detector = new GapDetector({ now: fixedNow, idGenerator: nextId });
    const result = detector.detect(entries);
    const structuralGaps = result.gaps.filter((g) => g.type === 'structural_gap');

    expect(structuralGaps.length).toBeGreaterThan(0);

    const tasks = generator.generate(result);
    const structuralTask = tasks.find((t) => t.gapType === 'structural_gap');
    expect(structuralTask).toBeDefined();
    expect(structuralTask!.scope.domain).toBe('networking');
    expect(structuralTask!.expectedKnowledgeTypes.length).toBeGreaterThan(0);
  });

  it('each strategy step has id, method, query, and rationale', () => {
    const detector = new GapDetector({ now: fixedNow, idGenerator: nextId });
    for (let i = 0; i < 3; i++) detector.recordQueryMiss('docker compose networking');
    const result = detector.detect([]);
    const tasks = generator.generate(result);
    const task = tasks[0];

    for (const step of task.strategy.steps) {
      expect(step.id).toBeTruthy();
      expect(step.method).toBeTruthy();
      expect(step.query).toBeTruthy();
      expect(step.rationale).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AC2: 调研任务定义中包含所需的信息获取方式，由宿主环境负责执行
// ═══════════════════════════════════════════════════════════════════════

describe('FR-D02 AC2: acquisition methods defined, host executes', () => {
  let generator: ResearchTaskGenerator;

  beforeEach(() => {
    idCounter = 0;
    generator = new ResearchTaskGenerator({ now: fixedNow, idGenerator: nextId });
  });

  it('frequency gap task includes web_search and document_read methods', () => {
    const detector = new GapDetector({ now: fixedNow, idGenerator: nextId });
    for (let i = 0; i < 5; i++) detector.recordQueryMiss('react server components');
    const result = detector.detect([]);
    const task = generator.generate(result)[0];

    expect(task.scope.acquisitionMethods).toContain('web_search');
    expect(task.scope.acquisitionMethods).toContain('document_read');
  });

  it('structural gap task may include paper_parse for non-experience gaps', () => {
    const entries = [
      makeEntry({ domain: 'algorithms', type: 'experience' }),
    ];
    const detector = new GapDetector({ now: fixedNow, idGenerator: nextId });
    const result = detector.detect(entries);
    const tasks = generator.generate(result);
    const structuralTask = tasks.find((t) => t.gapType === 'structural_gap');

    expect(structuralTask).toBeDefined();
    expect(structuralTask!.scope.acquisitionMethods).toContain('document_read');
    expect(structuralTask!.scope.acquisitionMethods).toContain('paper_parse');
  });

  it('executor delegates step execution to adapter (host boundary)', async () => {
    const executedSteps: string[] = [];
    const adapter: ResearchExecutorAdapter = {
      async execute(step) {
        executedSteps.push(step.id);
        return { artifacts: [makeArtifact(`art-${step.id}`)], apiCallsUsed: 1 };
      },
    };

    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-1',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Test task',
      objective: 'Test',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [
          { id: 'step-1', method: 'web_search', query: 'test query', rationale: 'test' },
          { id: 'step-2', method: 'document_read', query: 'test doc', rationale: 'test' },
        ],
        searchQueries: ['test'],
      },
      completionCriteria: ['at least 1 entry'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    await executor.execute(task);
    expect(executedSteps).toEqual(['step-1', 'step-2']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AC3: 调研结果经过知识提取流程后入库，形成闭环
// ═══════════════════════════════════════════════════════════════════════

describe('FR-D02 AC3: results extracted and saved to repository', () => {
  it('artifacts go through extraction pipeline and entries are saved', async () => {
    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const stepResults = new Map<string, ResearchStepResult>();
    stepResults.set('step-1', {
      artifacts: [makeArtifact('art-1')],
      apiCallsUsed: 1,
    });

    const adapter = makeMockAdapter(stepResults);
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-extract',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Extraction test',
      objective: 'Test extraction pipeline',
      scope: { topic: 'testing', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [{ id: 'step-1', method: 'web_search', query: 'test', rationale: 'test' }],
        searchQueries: ['test'],
      },
      completionCriteria: ['entries saved'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    const result = await executor.execute(task);

    expect(result.status).toBe('completed');
    expect(result.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(result.extractedEntries.length).toBeGreaterThanOrEqual(1);
    expect(result.savedEntryIds.length).toBeGreaterThanOrEqual(1);
    expect((repo as unknown as MockRepository).saved.length).toBeGreaterThanOrEqual(1);

    const savedEntry = (repo as unknown as MockRepository).saved[0];
    expect(savedEntry.source.type).toBe('research');
    expect(savedEntry.source.context).toBe('task-extract');
  });

  it('result summary reflects artifact and entry counts', async () => {
    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const stepResults = new Map<string, ResearchStepResult>();
    stepResults.set('s1', {
      artifacts: [makeArtifact('a1'), makeArtifact('a2')],
      apiCallsUsed: 2,
    });

    const adapter = makeMockAdapter(stepResults);
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-summary',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Summary test',
      objective: 'Test summary',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [{ id: 's1', method: 'web_search', query: 'test', rationale: 'test' }],
        searchQueries: ['test'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    const result = await executor.execute(task);
    expect(result.summary).toContain('2 份资料');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AC4: 调研任务有资源预算，超预算自动终止并报告已获取的部分结果
// ═══════════════════════════════════════════════════════════════════════

describe('FR-D02 AC4: budget enforcement with partial results', () => {
  it('terminates when API call budget is exceeded and reports partial results', async () => {
    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const stepResults = new Map<string, ResearchStepResult>();
    stepResults.set('s1', { artifacts: [makeArtifact('a1')], apiCallsUsed: 5 });
    stepResults.set('s2', { artifacts: [makeArtifact('a2')], apiCallsUsed: 5 });
    stepResults.set('s3', { artifacts: [makeArtifact('a3')], apiCallsUsed: 5 });

    const adapter = makeMockAdapter(stepResults);
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-budget',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Budget test',
      objective: 'Test budget',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [
          { id: 's1', method: 'web_search', query: 'q1', rationale: 'r1' },
          { id: 's2', method: 'web_search', query: 'q2', rationale: 'r2' },
          { id: 's3', method: 'web_search', query: 'q3', rationale: 'r3' },
        ],
        searchQueries: ['q1', 'q2', 'q3'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 600_000, maxApiCalls: 8 },
      priority: 'high',
      impactScore: 3,
      urgencyScore: 3,
      blocking: true,
      createdAt: fixedNow(),
    };

    const result = await executor.execute(task);

    expect(result.status).toBe('budget_exceeded');
    expect(result.terminationReason).toBeTruthy();
    expect(result.completedStepIds.length).toBeGreaterThan(0);
    expect(result.skippedStepIds.length).toBeGreaterThan(0);
    expect(result.consumedBudget.apiCalls).toBeGreaterThanOrEqual(5);
    expect(result.artifacts.length).toBeGreaterThan(0);
  });

  it('terminates when time budget is exceeded', async () => {
    let callCount = 0;
    const timeNow = () => {
      callCount++;
      if (callCount <= 2) return new Date('2026-05-01T10:00:00Z');
      return new Date('2026-05-01T10:20:00Z');
    };

    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const stepResults = new Map<string, ResearchStepResult>();
    stepResults.set('s1', { artifacts: [makeArtifact('a1')], apiCallsUsed: 1 });
    stepResults.set('s2', { artifacts: [makeArtifact('a2')], apiCallsUsed: 1 });

    const adapter = makeMockAdapter(stepResults);
    const executor = new ResearchExecutor({ adapter, repository: repo, now: timeNow });

    const task: ResearchTask = {
      id: 'task-time-budget',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Time budget test',
      objective: 'Test time budget',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [
          { id: 's1', method: 'web_search', query: 'q1', rationale: 'r1' },
          { id: 's2', method: 'web_search', query: 'q2', rationale: 'r2' },
        ],
        searchQueries: ['q1'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 5 * 60 * 1000, maxApiCalls: 100 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    const result = await executor.execute(task);
    expect(result.status).toBe('budget_exceeded');
    expect(result.skippedStepIds.length).toBeGreaterThan(0);
  });

  it('budget fields are tracked in consumedBudget', async () => {
    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const stepResults = new Map<string, ResearchStepResult>();
    stepResults.set('s1', { artifacts: [], apiCallsUsed: 3 });

    const adapter = makeMockAdapter(stepResults);
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-consumed',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Consumed budget test',
      objective: 'Test',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [{ id: 's1', method: 'web_search', query: 'q', rationale: 'r' }],
        searchQueries: ['q'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'low',
      impactScore: 1,
      urgencyScore: 1,
      blocking: false,
      createdAt: fixedNow(),
    };

    const result = await executor.execute(task);
    expect(result.consumedBudget.apiCalls).toBe(3);
    expect(result.consumedBudget.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AC5: 已完成的调研任务支持"重新调研"操作
// ═══════════════════════════════════════════════════════════════════════

describe('FR-D02 AC5: re-research completed tasks', () => {
  it('reExecute clears previous results and runs again', async () => {
    let executionCount = 0;
    const adapter: ResearchExecutorAdapter = {
      async execute(step) {
        executionCount++;
        return { artifacts: [makeArtifact(`art-run${executionCount}`)], apiCallsUsed: 1 };
      },
    };

    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-rerun',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Re-research test',
      objective: 'Test re-research',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [{ id: 's1', method: 'web_search', query: 'q', rationale: 'r' }],
        searchQueries: ['q'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    const firstResult = await executor.execute(task);
    expect(firstResult.status).toBe('completed');
    expect(firstResult.artifacts[0].id).toContain('run1');

    const secondResult = await executor.reExecute(task);
    expect(secondResult.status).toBe('completed');
    expect(secondResult.artifacts[0].id).toContain('run2');
    expect(executionCount).toBe(2);
  });

  it('reExecute produces fresh detail view', async () => {
    let run = 0;
    const adapter: ResearchExecutorAdapter = {
      async execute() {
        run++;
        return { artifacts: [makeArtifact(`art-${run}`)], apiCallsUsed: run };
      },
    };

    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-rerun-detail',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Re-research detail',
      objective: 'Test',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [{ id: 's1', method: 'web_search', query: 'q', rationale: 'r' }],
        searchQueries: ['q'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    await executor.execute(task);
    await executor.reExecute(task);

    const detail = executor.getTaskDetail('task-rerun-detail');
    expect(detail).not.toBeNull();
    expect(detail!.result.consumedBudget.apiCalls).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AC6: 调研任务提供详情视图，展示调研过程、中间产出、引用来源等完整上下文
// ═══════════════════════════════════════════════════════════════════════

describe('FR-D02 AC6: research task detail view', () => {
  it('getTaskDetail returns task, result, steps, artifacts, timeline', async () => {
    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const stepResults = new Map<string, ResearchStepResult>();
    stepResults.set('s1', { artifacts: [makeArtifact('a1')], apiCallsUsed: 2 });
    stepResults.set('s2', { artifacts: [makeArtifact('a2'), makeArtifact('a3')], apiCallsUsed: 3 });

    const adapter = makeMockAdapter(stepResults);
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-detail',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Detail view test',
      objective: 'Test detail view',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search', 'document_read'] },
      expectedKnowledgeTypes: ['fact', 'methodology'],
      strategy: {
        steps: [
          { id: 's1', method: 'web_search', query: 'q1', rationale: 'r1' },
          { id: 's2', method: 'document_read', query: 'q2', rationale: 'r2' },
        ],
        searchQueries: ['q1', 'q2'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 20 },
      priority: 'high',
      impactScore: 3,
      urgencyScore: 3,
      blocking: true,
      createdAt: fixedNow(),
    };

    await executor.execute(task);
    const detail = executor.getTaskDetail('task-detail');

    expect(detail).not.toBeNull();
    expect(detail!.task.id).toBe('task-detail');
    expect(detail!.result.status).toBe('completed');
    expect(detail!.steps).toHaveLength(2);
    expect(detail!.steps[0].status).toBe('completed');
    expect(detail!.steps[0].artifacts).toHaveLength(1);
    expect(detail!.steps[0].apiCallsUsed).toBe(2);
    expect(detail!.steps[1].artifacts).toHaveLength(2);
    expect(detail!.artifacts).toHaveLength(3);
    expect(detail!.extractedEntryIds.length).toBeGreaterThanOrEqual(1);

    expect(detail!.timeline.length).toBeGreaterThanOrEqual(4);
    const eventTypes = detail!.timeline.map((e) => e.event);
    expect(eventTypes).toContain('task_started');
    expect(eventTypes).toContain('step_started');
    expect(eventTypes).toContain('step_completed');
    expect(eventTypes).toContain('task_completed');
  });

  it('artifacts preserve reference URLs for source tracing', async () => {
    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const stepResults = new Map<string, ResearchStepResult>();
    stepResults.set('s1', {
      artifacts: [{
        id: 'a-ref',
        method: 'web_search' as const,
        title: 'Reference test',
        content: '# Reference\n\nContent with source.',
        reference: 'https://docs.example.com/guide',
      }],
      apiCallsUsed: 1,
    });

    const adapter = makeMockAdapter(stepResults);
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-ref',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Reference test',
      objective: 'Test references',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [{ id: 's1', method: 'web_search', query: 'q', rationale: 'r' }],
        searchQueries: ['q'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    await executor.execute(task);
    const detail = executor.getTaskDetail('task-ref');
    expect(detail!.artifacts[0].reference).toBe('https://docs.example.com/guide');
  });

  it('returns null for unknown task id', () => {
    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const adapter = makeMockAdapter();
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    expect(executor.getTaskDetail('nonexistent')).toBeNull();
  });

  it('detail view shows skipped steps when budget exceeded', async () => {
    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const stepResults = new Map<string, ResearchStepResult>();
    stepResults.set('s1', { artifacts: [makeArtifact('a1')], apiCallsUsed: 8 });
    stepResults.set('s2', { artifacts: [makeArtifact('a2')], apiCallsUsed: 1 });

    const adapter = makeMockAdapter(stepResults);
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-skip-detail',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Skip detail test',
      objective: 'Test',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [
          { id: 's1', method: 'web_search', query: 'q1', rationale: 'r1' },
          { id: 's2', method: 'web_search', query: 'q2', rationale: 'r2' },
        ],
        searchQueries: ['q1'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 600_000, maxApiCalls: 5 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    await executor.execute(task);
    const detail = executor.getTaskDetail('task-skip-detail');

    expect(detail!.steps[0].status).toBe('completed');
    expect(detail!.steps[1].status).toBe('skipped');
    const eventTypes = detail!.timeline.map((e) => e.event);
    expect(eventTypes).toContain('budget_exceeded');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scheduler integration: priority scoring and scheduling
// ═══════════════════════════════════════════════════════════════════════

describe('FR-D02 scheduler integration', () => {
  it('scheduler scores and orders tasks by priority', () => {
    const scheduler = new ResearchScheduler({ now: fixedNow });
    const generator = new ResearchTaskGenerator({ now: fixedNow, idGenerator: nextId });

    const detector = new GapDetector({ now: fixedNow, idGenerator: nextId });
    for (let i = 0; i < 6; i++) detector.recordQueryMiss('high priority topic');
    for (let i = 0; i < 3; i++) detector.recordQueryMiss('medium priority topic');

    const result = detector.detect([]);
    const tasks = generator.generate(result);

    const decision = scheduler.schedule(tasks, {
      maxConcurrentResearchTasks: 1,
      frequencyMs: 60_000,
    });

    expect(decision.runnable.length).toBeLessThanOrEqual(1);
    if (decision.runnable.length > 0) {
      expect(decision.runnable[0].priority).toBe('high');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Error handling
// ═══════════════════════════════════════════════════════════════════════

describe('FR-D02 error handling', () => {
  it('captures adapter errors and returns failed status', async () => {
    const adapter: ResearchExecutorAdapter = {
      async execute() {
        throw new Error('Network timeout');
      },
    };

    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-error',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Error test',
      objective: 'Test error handling',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [{ id: 's1', method: 'web_search', query: 'q', rationale: 'r' }],
        searchQueries: ['q'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    const result = await executor.execute(task);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Network timeout');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// P1 audit fixes
// ═══════════════════════════════════════════════════════════════════════

describe('P1-1: reExecute cleans up repository entries', () => {
  it('deletes previously saved entries from repository before re-executing', async () => {
    let run = 0;
    const adapter: ResearchExecutorAdapter = {
      async execute() {
        run++;
        return { artifacts: [makeArtifact(`art-${run}`)], apiCallsUsed: 1 };
      },
    };

    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-cleanup',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Cleanup test',
      objective: 'Test cleanup',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [{ id: 's1', method: 'web_search', query: 'q', rationale: 'r' }],
        searchQueries: ['q'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    const firstResult = await executor.execute(task);
    expect(firstResult.savedEntryIds.length).toBeGreaterThan(0);

    await executor.reExecute(task);

    const mockRepo = repo as unknown as MockRepository;
    for (const id of firstResult.savedEntryIds) {
      expect(mockRepo.deleted).toContain(id);
    }
  });
});

describe('P1-2: per-step fault tolerance', () => {
  it('continues after a single step failure and returns partial_success', async () => {
    const adapter: ResearchExecutorAdapter = {
      async execute(step) {
        if (step.id === 's2') throw new Error('Step 2 failed');
        return { artifacts: [makeArtifact(`art-${step.id}`)], apiCallsUsed: 1 };
      },
    };

    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-partial',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Partial test',
      objective: 'Test partial',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [
          { id: 's1', method: 'web_search', query: 'q1', rationale: 'r1' },
          { id: 's2', method: 'web_search', query: 'q2', rationale: 'r2' },
          { id: 's3', method: 'web_search', query: 'q3', rationale: 'r3' },
        ],
        searchQueries: ['q1', 'q2', 'q3'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 20 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    const result = await executor.execute(task);

    expect(result.status).toBe('partial_success');
    expect(result.completedStepIds).toEqual(['s1', 's3']);
    expect(result.error).toContain('Step 2 failed');
    expect(result.artifacts.length).toBe(2);
  });

  it('returns failed when all steps fail', async () => {
    const adapter: ResearchExecutorAdapter = {
      async execute() {
        throw new Error('Always fails');
      },
    };

    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-all-fail',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'All fail test',
      objective: 'Test',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [{ id: 's1', method: 'web_search', query: 'q', rationale: 'r' }],
        searchQueries: ['q'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    const result = await executor.execute(task);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Always fails');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AC2 supplement: WebFetchAdapter searchFn host callback
// ═══════════════════════════════════════════════════════════════════════

describe('FR-D02 AC2: WebFetchAdapter searchFn host callback', () => {
  // Dynamic import to avoid top-level coupling
  async function loadAdapter() {
    const { WebFetchAdapter } = await import('../web-fetch-adapter.js');
    return WebFetchAdapter;
  }

  it('delegates natural-language web_search queries to host searchFn', async () => {
    const WebFetchAdapter = await loadAdapter();
    const searchCalls: { query: string; limit: number }[] = [];

    const adapter = new WebFetchAdapter({
      searchFn: async (query, limit) => {
        searchCalls.push({ query, limit });
        return [
          { url: 'https://example.com/result1', title: 'Result 1', content: 'Content about the topic.' },
          { url: 'https://example.com/result2', title: 'Result 2', content: 'More content.' },
        ];
      },
    });

    const step: ResearchStep = {
      id: 'step-search',
      method: 'web_search',
      query: 'kubernetes pod scheduling',
      rationale: 'test',
      limit: 5,
    };

    const task: ResearchTask = {
      id: 'task-host-search',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Host search test',
      objective: 'Test host search',
      scope: { topic: 'k8s', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: { steps: [step], searchQueries: ['kubernetes pod scheduling'] },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    const result = await adapter.execute(step, task);

    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].query).toBe('kubernetes pod scheduling');
    expect(searchCalls[0].limit).toBe(5);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts[0].reference).toBe('https://example.com/result1');
    expect(result.artifacts[0].title).toBe('Result 1');
    expect(result.artifacts[0].content).toBe('Content about the topic.');
    expect(result.apiCallsUsed).toBe(1);
  });

  it('falls back to empty result when no searchFn and no URLs in query', async () => {
    const WebFetchAdapter = await loadAdapter();
    const adapter = new WebFetchAdapter();

    const step: ResearchStep = {
      id: 'step-no-fn',
      method: 'web_search',
      query: 'natural language query without urls',
      rationale: 'test',
    };

    const task: ResearchTask = {
      id: 'task-no-fn',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'No searchFn test',
      objective: 'Test',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: { steps: [step], searchQueries: ['q'] },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    const result = await adapter.execute(step, task);
    expect(result.artifacts).toHaveLength(0);
    expect(result.apiCallsUsed).toBe(0);
  });

  it('does not call searchFn for document_read method even without URLs', async () => {
    const WebFetchAdapter = await loadAdapter();
    let searchCalled = false;

    const adapter = new WebFetchAdapter({
      searchFn: async () => {
        searchCalled = true;
        return [];
      },
    });

    const step: ResearchStep = {
      id: 'step-doc',
      method: 'document_read',
      query: 'some document topic',
      rationale: 'test',
    };

    const task: ResearchTask = {
      id: 'task-doc-method',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'Doc method test',
      objective: 'Test',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['document_read'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: { steps: [step], searchQueries: ['q'] },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    const result = await adapter.execute(step, task);
    expect(searchCalled).toBe(false);
    expect(result.artifacts).toHaveLength(0);
  });

  it('still uses URL fetch when query contains URLs even with searchFn', async () => {
    const WebFetchAdapter = await loadAdapter();
    let searchCalled = false;

    const adapter = new WebFetchAdapter({
      searchFn: async () => {
        searchCalled = true;
        return [];
      },
      fetchFn: async () => new Response('<html><body><p>Fetched content</p></body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
    });

    const step: ResearchStep = {
      id: 'step-url',
      method: 'web_search',
      query: 'https://example.com/page',
      rationale: 'test',
    };

    const task: ResearchTask = {
      id: 'task-url-fetch',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'URL fetch test',
      objective: 'Test',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: { steps: [step], searchQueries: ['q'] },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    const result = await adapter.execute(step, task);
    expect(searchCalled).toBe(false);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].content).toContain('Fetched content');
  });
});

describe('P1-3: escapeFrontmatterValue handles YAML special characters', () => {
  it('artifact with colons and quotes in title produces valid frontmatter', async () => {
    const repo = new MockRepository() as unknown as KnowledgeRepository;
    const stepResults = new Map<string, ResearchStepResult>();
    stepResults.set('s1', {
      artifacts: [{
        id: 'a-yaml',
        method: 'web_search' as const,
        title: 'Key: "value" with special chars',
        content: '# Content\n\nBody text.',
        reference: 'https://example.com/yaml',
      }],
      apiCallsUsed: 1,
    });

    const adapter = makeMockAdapter(stepResults);
    const executor = new ResearchExecutor({ adapter, repository: repo, now: fixedNow });

    const task: ResearchTask = {
      id: 'task-yaml',
      gapId: 'gap-1',
      gapType: 'frequency_blind_spot',
      title: 'YAML escape test',
      objective: 'Test YAML escaping',
      scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
      expectedKnowledgeTypes: ['fact'],
      strategy: {
        steps: [{ id: 's1', method: 'web_search', query: 'q', rationale: 'r' }],
        searchQueries: ['q'],
      },
      completionCriteria: ['done'],
      budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
      priority: 'medium',
      impactScore: 2,
      urgencyScore: 2,
      blocking: false,
      createdAt: fixedNow(),
    };

    const result = await executor.execute(task);
    expect(result.status).toBe('completed');
    expect(result.extractedEntries.length).toBeGreaterThanOrEqual(1);
  });
});
