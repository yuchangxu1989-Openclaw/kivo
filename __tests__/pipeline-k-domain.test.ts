/**
 * Tests for Domain K: Knowledge Pipeline Orchestration
 * FR-K01, FR-K02
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PipelineOrchestrator,
  type PipelineStageHandler,
  type StageContext,
  type StageResult,
} from '../src/pipeline/pipeline-orchestrator.js';
import {
  KnowledgeRouter,
  type RoutingRule,
} from '../src/pipeline/knowledge-router.js';
import {
  MergeDetector,
} from '../src/pipeline/merge-detector.js';
import type { KnowledgeEntry, KnowledgeSource, PipelineEvent } from '../src/types/index.js';

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'test',
  timestamp: new Date(),
};

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    type: 'fact',
    title: 'Test Entry',
    content: 'Test content for knowledge entry.',
    summary: 'Test summary',
    source: testSource,
    confidence: 0.9,
    status: 'active',
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

// ── Helper stage factories ──

function createStage(name: string, transform?: (ctx: StageContext) => StageResult): PipelineStageHandler {
  return {
    name,
    async execute(ctx: StageContext): Promise<StageResult> {
      if (transform) return transform(ctx);
      return { entries: ctx.entries };
    },
  };
}

function createExtractionStage(): PipelineStageHandler {
  return {
    name: 'extraction',
    async execute(ctx: StageContext): Promise<StageResult> {
      // Simulate extraction: split input into entries
      const paragraphs = ctx.input.split(/\n\s*\n/).filter(p => p.trim().length > 10);
      const entries = paragraphs.map(p => makeEntry({
        content: p.trim(),
        title: p.trim().slice(0, 50),
        source: ctx.source,
      }));
      return { entries };
    },
  };
}

function createClassificationStage(): PipelineStageHandler {
  return {
    name: 'classification',
    async execute(ctx: StageContext): Promise<StageResult> {
      const entries = ctx.entries.map(e => ({
        ...e,
        type: e.content.includes('方法') ? 'methodology' as const : 'fact' as const,
        confidence: 0.8,
      }));
      return { entries, metadata: { classified: entries.length } };
    },
  };
}

function createPersistenceStage(): PipelineStageHandler {
  const persisted: KnowledgeEntry[] = [];
  return {
    name: 'persistence',
    async execute(ctx: StageContext): Promise<StageResult> {
      persisted.push(...ctx.entries);
      return { entries: ctx.entries, metadata: { persisted: ctx.entries.length } };
    },
  };
}

// ── FR-K01: Pipeline Stage Orchestration ──

describe('FR-K01: Pipeline Stage Orchestration', () => {
  let orchestrator: PipelineOrchestrator;

  beforeEach(() => {
    orchestrator = new PipelineOrchestrator();
  });

  it('AC1: pipeline executes stages in registered order', async () => {
    const order: string[] = [];

    orchestrator.registerStage(createStage('extraction', (ctx) => {
      order.push('extraction');
      return { entries: [makeEntry()] };
    }));
    orchestrator.registerStage(createStage('analysis_artifact', (ctx) => {
      order.push('analysis_artifact');
      return { entries: ctx.entries };
    }));
    orchestrator.registerStage(createStage('classification', (ctx) => {
      order.push('classification');
      return { entries: ctx.entries };
    }));
    orchestrator.registerStage(createStage('conflict_detection', (ctx) => {
      order.push('conflict_detection');
      return { entries: ctx.entries };
    }));
    orchestrator.registerStage(createStage('merge_detection', (ctx) => {
      order.push('merge_detection');
      return { entries: ctx.entries };
    }));
    orchestrator.registerStage(createStage('persistence', (ctx) => {
      order.push('persistence');
      return { entries: ctx.entries };
    }));

    const task = await orchestrator.execute('test input', testSource);

    expect(order).toEqual([
      'extraction',
      'analysis_artifact',
      'classification',
      'conflict_detection',
      'merge_detection',
      'persistence',
    ]);
    expect(task.status).toBe('completed');
    expect(task.completedStages).toEqual(order);
  });

  it('AC1: each stage independently skippable', async () => {
    const order: string[] = [];

    orchestrator.registerStage(createStage('extraction', () => {
      order.push('extraction');
      return { entries: [makeEntry()] };
    }));
    orchestrator.registerStage(createStage('analysis_artifact', (ctx) => {
      order.push('analysis_artifact');
      return { entries: ctx.entries };
    }));
    orchestrator.registerStage(createStage('classification', (ctx) => {
      order.push('classification');
      return { entries: ctx.entries };
    }));

    orchestrator.setSkipStages(['analysis_artifact']);
    const task = await orchestrator.execute('test', testSource);

    expect(order).toEqual(['extraction', 'classification']);
    expect(task.skippedStages).toContain('analysis_artifact');
    expect(task.completedStages).not.toContain('analysis_artifact');
  });

  it('AC2: stages communicate via events', async () => {
    const events: PipelineEvent[] = [];
    orchestrator.registerStage(createExtractionStage());
    orchestrator.registerStage(createClassificationStage());

    orchestrator.bus.onAny(event => events.push(event));

    await orchestrator.execute('TypeScript is a typed superset of JavaScript.', testSource);

    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('task:created');
    expect(eventTypes).toContain('task:started');
    expect(eventTypes).toContain('stage:entered');
    expect(eventTypes).toContain('stage:completed');
    expect(eventTypes).toContain('task:completed');
  });

  it('AC3: stage failure halts pipeline, records context', async () => {
    orchestrator.registerStage(createStage('extraction', () => {
      return { entries: [makeEntry()] };
    }));
    orchestrator.registerStage(createStage('classification', () => {
      throw new Error('Classification failed');
    }));
    orchestrator.registerStage(createStage('persistence', (ctx) => {
      return { entries: ctx.entries };
    }));

    await expect(orchestrator.execute('test', testSource)).rejects.toThrow('Classification failed');

    // Check that the task recorded the failure
    const tasks = Array.from({ length: 1 }, (_, i) => {
      // Get the task from the orchestrator
      const allTasks: any[] = [];
      // We need to check via events
      return null;
    });

    // Verify via events
    const events: PipelineEvent[] = [];
    orchestrator.bus.onAny(e => events.push(e));

    // Run again to capture events
    const orch2 = new PipelineOrchestrator();
    orch2.registerStage(createStage('extraction', () => ({ entries: [makeEntry()] })));
    orch2.registerStage(createStage('classification', () => { throw new Error('fail'); }));

    const failEvents: PipelineEvent[] = [];
    orch2.bus.onAny(e => failEvents.push(e));

    try { await orch2.execute('test', testSource); } catch { /* expected */ }

    expect(failEvents.some(e => e.type === 'task:failed')).toBe(true);
    const failEvent = failEvents.find(e => e.type === 'task:failed')!;
    expect(failEvent.stage).toBe('classification');
  });

  it('AC3: failed pipeline does not affect other instances', async () => {
    const orch1 = new PipelineOrchestrator();
    orch1.registerStage(createStage('extraction', () => { throw new Error('fail'); }));

    const orch2 = new PipelineOrchestrator();
    orch2.registerStage(createStage('extraction', () => ({ entries: [makeEntry()] })));

    await expect(orch1.execute('test', testSource)).rejects.toThrow();
    const task2 = await orch2.execute('test', testSource);
    expect(task2.status).toBe('completed');
  });

  it('AC4: extensible — new stage registered without modifying existing', () => {
    orchestrator.registerStage(createStage('extraction'));
    orchestrator.registerStage(createStage('classification'));

    // Add custom stage between extraction and classification
    orchestrator.registerStageBefore(
      createStage('custom_enrichment'),
      'classification',
    );

    expect(orchestrator.getRegisteredStages()).toEqual([
      'extraction',
      'custom_enrichment',
      'classification',
    ]);
  });

  it('AC4: registerStageAfter inserts correctly', () => {
    orchestrator.registerStage(createStage('extraction'));
    orchestrator.registerStage(createStage('persistence'));

    orchestrator.registerStageAfter(
      createStage('validation'),
      'extraction',
    );

    expect(orchestrator.getRegisteredStages()).toEqual([
      'extraction',
      'validation',
      'persistence',
    ]);
  });

  it('rejects duplicate stage registration', () => {
    orchestrator.registerStage(createStage('extraction'));
    expect(() => orchestrator.registerStage(createStage('extraction'))).toThrow(/already registered/);
  });

  it('halt support — stage can halt pipeline gracefully', async () => {
    orchestrator.registerStage(createStage('extraction', () => ({
      entries: [makeEntry({ confidence: 0.1 })],
    })));
    orchestrator.registerStage(createStage('quality_gate', (ctx) => ({
      entries: ctx.entries,
      halt: true,
      haltReason: 'All entries below confidence threshold',
    })));
    orchestrator.registerStage(createStage('persistence', (ctx) => ({
      entries: ctx.entries,
    })));

    const task = await orchestrator.execute('test', testSource);
    expect(task.status).toBe('halted');
    expect(task.haltReason).toContain('confidence threshold');
    expect(task.completedStages).not.toContain('persistence');
  });
});

// ── FR-K02: Knowledge Classification & Routing ──

describe('FR-K02: Knowledge Classification & Routing', () => {
  let router: KnowledgeRouter;

  beforeEach(() => {
    router = new KnowledgeRouter();
  });

  it('AC1: identifies knowledge type and routes accordingly', () => {
    const factEntry = makeEntry({ type: 'fact', confidence: 0.9 });
    const decision = router.route(factEntry);
    expect(decision.conflictStrategy).toBe('strict');
    expect(decision.persistenceRule).toBe('auto');
  });

  it('AC2: different types get different conflict strategies', () => {
    const fact = router.route(makeEntry({ type: 'fact', confidence: 0.9 }));
    const methodology = router.route(makeEntry({ type: 'methodology', confidence: 0.9 }));
    const meta = router.route(makeEntry({ type: 'meta', confidence: 0.9 }));

    expect(fact.conflictStrategy).toBe('strict');
    expect(methodology.conflictStrategy).toBe('relaxed');
    expect(meta.conflictStrategy).toBe('skip');
  });

  it('AC2: custom routing rules override defaults', () => {
    const customRouter = new KnowledgeRouter({
      rules: [
        { type: 'fact', conflictStrategy: 'relaxed', persistenceRule: 'review_required' },
      ],
    });

    const decision = customRouter.route(makeEntry({ type: 'fact', confidence: 0.9 }));
    expect(decision.conflictStrategy).toBe('relaxed');
    expect(decision.persistenceRule).toBe('review_required');
  });

  it('AC3: low confidence marks entry for manual review', () => {
    const lowConfidence = makeEntry({ confidence: 0.2 });
    const decision = router.route(lowConfidence);
    expect(decision.requiresManualReview).toBe(true);
    expect(decision.persistenceRule).toBe('review_required');
    expect(decision.reason).toContain('below threshold');
  });

  it('AC3: high confidence proceeds automatically', () => {
    const highConfidence = makeEntry({ confidence: 0.9 });
    const decision = router.route(highConfidence);
    expect(decision.requiresManualReview).toBe(false);
  });

  it('AC3: per-type confidence threshold override', () => {
    const customRouter = new KnowledgeRouter({
      rules: [
        { type: 'decision', conflictStrategy: 'strict', persistenceRule: 'auto', confidenceThreshold: 0.8 },
      ],
    });

    const entry = makeEntry({ type: 'decision', confidence: 0.6 });
    const decision = customRouter.route(entry);
    expect(decision.requiresManualReview).toBe(true);
  });

  it('partition separates entries by routing decision', () => {
    const entries = [
      makeEntry({ type: 'fact', confidence: 0.9 }),
      makeEntry({ type: 'meta', confidence: 0.9 }),
      makeEntry({ type: 'fact', confidence: 0.2 }),
    ];

    const { autoProcess, manualReview, skipConflict } = router.partition(entries);
    expect(autoProcess.length).toBe(1); // fact with high confidence
    expect(skipConflict.length).toBe(1); // meta skips conflict
    expect(manualReview.length).toBe(1); // low confidence fact
  });

  it('dynamic rule update', () => {
    router.updateRule({ type: 'fact', conflictStrategy: 'skip', persistenceRule: 'auto' });
    const decision = router.route(makeEntry({ type: 'fact', confidence: 0.9 }));
    expect(decision.conflictStrategy).toBe('skip');
  });
});

// ── MergeDetector ──

describe('MergeDetector', () => {
  it('detects similar entries as merge candidates', async () => {
    const detector = new MergeDetector({ similarityThreshold: 0.5 });
    const entries = [
      makeEntry({
        id: 'a',
        type: 'fact',
        title: 'TypeScript compiler overview',
        content: 'TypeScript compiler tsc converts TypeScript code to JavaScript output files.',
      }),
      makeEntry({
        id: 'b',
        type: 'fact',
        title: 'TypeScript compiler description',
        content: 'TypeScript compiler tsc converts TypeScript code to JavaScript output files.',
      }),
    ];

    const candidates = await detector.detect(entries);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].entryA).toBe('a');
    expect(candidates[0].entryB).toBe('b');
    expect(candidates[0].similarity).toBeGreaterThanOrEqual(0.5);
  });

  it('does not flag dissimilar entries', async () => {
    const detector = new MergeDetector({ similarityThreshold: 0.7 });
    const entries = [
      makeEntry({
        id: 'a',
        type: 'fact',
        title: 'TypeScript compiler',
        content: 'TypeScript compiler converts TS to JS.',
      }),
      makeEntry({
        id: 'b',
        type: 'methodology',
        title: 'Agile methodology',
        content: 'Agile is an iterative approach to project management.',
      }),
    ];

    const candidates = await detector.detect(entries);
    expect(candidates).toHaveLength(0);
  });

  it('checks against existing entries when queryExisting provided', async () => {
    const existingEntry = makeEntry({
      id: 'existing-1',
      type: 'fact',
      title: 'TypeScript compiler overview',
      content: 'TypeScript compiler tsc converts TypeScript code to JavaScript output files.',
    });

    const detector = new MergeDetector({
      similarityThreshold: 0.5,
      queryExisting: async () => [existingEntry],
    });

    const newEntries = [
      makeEntry({
        id: 'new-1',
        type: 'fact',
        title: 'TypeScript compiler description',
        content: 'TypeScript compiler tsc converts TypeScript code to JavaScript output files.',
      }),
    ];

    const candidates = await detector.detect(newEntries);
    expect(candidates.some(c => c.entryB === 'existing-1')).toBe(true);
  });
});
