import { describe, it, expect } from 'vitest';
import {
  AnalysisArtifactStore,
  CapabilityRegistry,
  Classifier,
  ConflictDetector,
  KnowledgeRepository,
  OpenClawAdapter,
  PipelineEngine,
  SQLiteProvider,
  StandaloneAdapter,
  type KnowledgeEntry,
  type KnowledgeSource,
} from '../src/index.js';
import { ContextInjector } from '../src/injection/context-injector.js';
import { EventBus } from '../src/pipeline/event-bus.js';
import type { LLMJudgeProvider } from '../src/conflict/spi.js';
import { Kivo } from '../src/kivo.js';
import type { KivoConfig } from '../src/config.js';

const testSource: KnowledgeSource = {
  type: 'conversation',
  reference: 'test://batch4',
  timestamp: new Date('2026-04-29T09:13:00.000Z'),
  agent: 'codex',
};

const memoryConfig: KivoConfig = {
  dbPath: ':memory:',
  pipelineOptions: { extractor: { minContentLength: 10 } },
};

const llmJudge: LLMJudgeProvider = {
  async judgeConflict() {
    return 'conflict';
  },
};

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const now = new Date('2026-04-29T09:13:00.000Z');
  return {
    id: overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`,
    type: overrides.type ?? 'fact',
    title: overrides.title ?? 'entry title',
    content: overrides.content ?? 'entry content',
    summary: overrides.summary ?? 'entry summary',
    source: overrides.source ?? testSource,
    confidence: overrides.confidence ?? 0.9,
    status: overrides.status ?? 'active',
    tags: overrides.tags ?? [],
    domain: overrides.domain,
    metadata: overrides.metadata,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    version: overrides.version ?? 1,
    supersedes: overrides.supersedes,
  };
}

describe('CapabilityRegistry Batch 4', () => {
  it('registers host capabilities, selects provider and resolves activated domains', async () => {
    const registry = new CapabilityRegistry({ selectionStrategy: 'priority' });
    const events: string[] = [];

    registry.onCapabilityChange((event) => {
      events.push(`${event.capability.name}:${event.capability.available}`);
    });

    registry.registerHostCapabilities([
      { name: 'file-read', version: '1.0.0', contract: 'workspace-read', available: true },
      { name: 'file-write', version: '1.0.0', contract: 'workspace-write', available: true },
      { name: 'tool-exec', version: '1.0.0', contract: 'tool-call', available: false },
    ]);
    registry.registerProvider({
      id: 'provider-a',
      capabilities: ['text-generation'],
      priority: 10,
      available: true,
    });
    registry.registerProvider({
      id: 'provider-b',
      capabilities: ['text-generation', 'structured-output'],
      priority: 5,
      available: true,
    });

    await registry.updateCapability('tool-exec', { available: true });

    expect(registry.selectProvider('text-generation')?.id).toBe('provider-a');
    expect(registry.selectProvider('structured-output')?.id).toBe('provider-b');
    expect(events).toContain('tool-exec:true');
    expect(registry.resolveActivatedDomains()).toEqual({
      dictionary: true,
      pipeline: true,
      artifactReview: true,
      conflictDetection: 'full',
    });
  });

  it('supports round-robin provider selection and availability updates', () => {
    const registry = new CapabilityRegistry({ selectionStrategy: 'round-robin' });
    registry.registerProvider({ id: 'p1', capabilities: ['embedding'], available: true });
    registry.registerProvider({ id: 'p2', capabilities: ['embedding'], available: true });

    expect(registry.selectProvider('embedding')?.id).toBe('p1');
    expect(registry.selectProvider('embedding')?.id).toBe('p2');
    registry.updateProviderAvailability('p1', false);
    expect(registry.selectProvider('embedding')?.id).toBe('p2');
  });
});

describe('Adapters Batch 4', () => {
  it('standalone and openclaw adapters expose host capabilities', async () => {
    const kivo = new Kivo(memoryConfig);
    await kivo.init();

    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repository = new KnowledgeRepository(provider);
    const injector = new ContextInjector({ repository });
    const eventBus = new EventBus();

    const standalone = new StandaloneAdapter({ kivo, injector });
    const openclaw = new OpenClawAdapter({ kivo, injector, eventBus });

    standalone.registerHostCapabilities?.([
      { name: 'llm', version: '1.1.0', contract: 'prompt->completion', available: true },
    ]);

    expect(standalone.getHostCapabilities?.()[0].name).toBe('llm');
    expect(await standalone.readSource?.('doc-1')).toBe('memory://doc-1');
    await expect(standalone.writeExport?.('/tmp/out.txt', 'ok')).resolves.toBeUndefined();
    expect(openclaw.getHostCapabilities?.().some(cap => cap.name === 'file-read')).toBe(true);
    expect(await openclaw.readSource?.('doc-2')).toBe('openclaw://doc-2');

    await kivo.shutdown();
  });
});

describe('AnalysisArtifactStore Batch 4', () => {
  it('queues low-confidence artifacts for review and converts queries to research tasks', async () => {
    const store = new AnalysisArtifactStore();
    const artifact = await store.saveArtifact({
      sourceId: 'source-1',
      pipelineId: 'pipe-1',
      extractedClaims: [{ id: 'claim-1', text: '待确认事实', confidence: 0.4, type: 'fact' }],
      entityCandidates: [{ id: 'entity-1', label: '待确认实体', confidence: 0.4 }],
      conceptCandidates: [],
      linkCandidates: [],
      conflictCandidates: [],
      gapCandidates: [{ id: 'gap-1', label: '缺口', confidence: 0.6 }],
      reviewCandidates: [{
        id: 'review-1',
        field: 'extractedClaims',
        candidateId: 'claim-1',
        reason: 'low_confidence',
        confidence: 0.4,
      }],
      recommendedResearchQueries: ['OpenClaw browser lease failure'],
      confidence: 0.4,
    });

    expect(artifact.status).toBe('pending_review');
    expect((await store.listReviewQueue())).toHaveLength(1);

    const approved = await store.approveCandidate(artifact.id, {
      candidateId: 'claim-1',
      action: 'approved',
      editedValue: '已确认事实',
    });
    expect(approved.status).toBe('approved');
    expect(approved.extractedClaims[0].text).toBe('已确认事实');
    expect(await store.listReviewQueue()).toHaveLength(0);

    const tasks = await store.createResearchTasksFromArtifact({ artifactId: artifact.id, priority: 'high' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain('OpenClaw browser lease failure');
    expect(tasks[0].priority).toBe('high');
  });
});

describe('PipelineEngine Batch 4', () => {
  it('runs analysis artifact + routing stages and persists only active entries', async () => {
    const saved: KnowledgeEntry[] = [];
    const repository = {
      save: async (entry: KnowledgeEntry) => {
        saved.push(entry);
      },
    } as unknown as KnowledgeRepository;

    const artifactStore = new AnalysisArtifactStore();
    const engine = new PipelineEngine({
      repository,
      analysisArtifactStore: artifactStore,
      confidenceThreshold: 0.5,
      extractor: { minContentLength: 10 },
      conflictDetector: new ConflictDetector({ llmJudgeProvider: llmJudge }),
    });

    const events: Array<{ type: string; stage: string; payload: Record<string, unknown> }> = [];
    engine.bus.onAny((event) => {
      events.push({ type: event.type, stage: event.stage, payload: event.payload });
    });

    const taskId = engine.submit(
      [
        'TypeScript pipeline architecture 是当前工程规范和最佳实践，所有新模块必须遵循这个架构规范来实现。',
        '',
        '需要确认这个 browser lease failure 的根因是什么，包括网络超时、资源竞争和配置错误等可能性。',
      ].join('\n'),
      testSource,
    );

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pipeline timeout')), 1500);
      engine.bus.on('task:completed', (event) => {
        if (event.taskId === taskId) {
          clearTimeout(timer);
          resolve();
        }
      });
      engine.bus.on('task:failed', (event) => {
        if (event.taskId === taskId) {
          clearTimeout(timer);
          reject(new Error(String(event.payload.error ?? 'pipeline failed')));
        }
      });
    });

    const task = engine.getTask(taskId);
    expect(task?.status).toBe('completed');
    expect(task?.artifactId).toBeTruthy();
    expect(saved.length).toBe(2);
    expect(saved.every(entry => entry.status === 'active')).toBe(true);

    const stages = events.filter(event => event.type === 'stage:completed' || event.type === 'stage:skipped');
    expect(stages.some(event => event.stage === 'analysis_artifact')).toBe(true);
    expect(stages.some(event => event.stage === 'merge_detection')).toBe(true);
    expect(stages.some(event => event.stage === 'quality_gate')).toBe(true);
    expect(events.some(event => event.type === 'entry:extracted' && typeof event.payload.route === 'string')).toBe(true);

    const artifact = await artifactStore.loadArtifact(task!.artifactId!);
    expect(artifact).not.toBeNull();
    expect(artifact?.status).toBe('ready');
    expect(artifact?.gapCandidates.length).toBeGreaterThan(0);
    expect(artifact?.reviewCandidates.length).toBe(0);
    expect(artifact?.recommendedResearchQueries.length).toBe(0);

    engine.destroy();
  });

  it('records failedStage and failureContext when persistence fails', async () => {
    const engine = new PipelineEngine({
      repository: {
        save: async () => {
          throw new Error('persistence exploded');
        },
      } as unknown as KnowledgeRepository,
      extractor: { minContentLength: 10 },
      confidenceThreshold: 0,
      qualityGateEnabled: false,
    });

    const taskId = engine.submit('这是一个足够长的工程事实，用于触发持久化失败。需要更多工程规则和最佳实践来确保系统稳定性和可维护性。', testSource);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      engine.bus.on('task:failed', (event) => {
        if (event.taskId === taskId) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const task = engine.getTask(taskId);
    expect(task?.status).toBe('failed');
    expect(task?.failedStage).toBe('persistence');
    expect(task?.failureContext).toMatchObject({ activeEntryCount: expect.any(Number) });

    engine.destroy();
  });
});

describe('Classifier Batch 4', () => {
  it('returns domain routing hints together with type and confidence', async () => {
    const classifier = new Classifier();
    const governance = await classifier.classify('术语治理要求 prompt injection 和知识规则统一。');
    const engineering = await classifier.classify('TypeScript pipeline architecture with vitest and sqlite.');

    expect(governance.domain).toBe('governance');
    expect(engineering.domain).toBe('engineering');
  });
});
