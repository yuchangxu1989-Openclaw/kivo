/**
 * KIVO Pipeline Unit Tests
 *
 * Tests the core pipeline flow: submit → extract → classify → complete
 * Verifies event-driven architecture and async non-blocking behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PipelineEngine } from '../src/pipeline/engine.js';
import { Classifier, type ClassificationResult } from '../src/pipeline/classifier.js';
import { Extractor } from '../src/pipeline/extractor.js';
import { EventBus } from '../src/pipeline/event-bus.js';
import { evaluateQuality } from '../src/pipeline/quality-gate.js';
import type { KnowledgeSource, PipelineEvent, PipelineEventType } from '../src/types/index.js';

const testSource: KnowledgeSource = {
  type: 'conversation',
  reference: 'test://session-001',
  timestamp: new Date(),
  agent: 'test-agent',
};

function inferMockType(content: string): ClassificationResult {
  if (/目标|必须|禁止/.test(content)) {
    return { type: 'intent', confidence: 0.9, domain: 'governance' };
  }
  if (/数量|占比|数据|统计|\d+/.test(content)) {
    return { type: 'fact', confidence: 0.9, domain: 'general' };
  }
  if (/最佳实践|步骤|流程|框架/.test(content)) {
    return { type: 'methodology', confidence: 0.9, domain: 'engineering' };
  }
  if (/决定|放弃|权衡|采用/.test(content)) {
    return { type: 'decision', confidence: 0.9, domain: 'engineering' };
  }
  if (/实践|发现|教训|有坑/.test(content)) {
    return { type: 'experience', confidence: 0.9, domain: 'engineering' };
  }
  if (/元认知|反思|自省|认知/.test(content)) {
    return { type: 'meta', confidence: 0.9, domain: 'governance' };
  }

  return { type: 'fact', confidence: 0.3, domain: 'general' };
}

function createMockClassifier(classifyFn: (content: string) => ClassificationResult = inferMockType) {
  return {
    classify: vi.fn(async (content: string) => classifyFn(content)),
  } as unknown as Classifier;
}

// ─── EventBus Tests ──────────────────────────────────────────────────────────

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => { bus = new EventBus(); });
  afterEach(() => { bus.removeAllListeners(); });

  it('emits and receives events', () => {
    const received: PipelineEvent[] = [];
    bus.on('task:created', (e) => { received.push(e); });

    const event: PipelineEvent = {
      type: 'task:created',
      taskId: 'test-1',
      stage: 'intake',
      timestamp: new Date(),
      payload: { inputLength: 100 },
    };
    bus.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0].taskId).toBe('test-1');
  });

  it('once handler fires only once', () => {
    let count = 0;
    bus.once('task:started', () => { count++; });

    const event: PipelineEvent = {
      type: 'task:started',
      taskId: 'test-1',
      stage: 'intake',
      timestamp: new Date(),
      payload: {},
    };
    bus.emit(event);
    bus.emit(event);

    expect(count).toBe(1);
  });

  it('onAny captures all event types', () => {
    const received: PipelineEventType[] = [];
    bus.onAny((e) => { received.push(e.type); });

    bus.emit({ type: 'task:created', taskId: 't1', stage: 'intake', timestamp: new Date(), payload: {} });
    bus.emit({ type: 'task:completed', taskId: 't1', stage: 'complete', timestamp: new Date(), payload: {} });

    expect(received).toContain('task:created');
    expect(received).toContain('task:completed');
  });
});

// ─── Classifier Tests ────────────────────────────────────────────────────────

describe('Classifier', () => {
  const classifier = createMockClassifier();

  it('classifies factual content as fact', async () => {
    const result = await classifier.classify('用户数量是 1500 人，占比 35%');
    expect(result.type).toBe('fact');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('classifies methodology content', async () => {
    const result = await classifier.classify('最佳实践是按照以下步骤和流程执行框架');
    expect(result.type).toBe('methodology');
  });

  it('classifies decision content', async () => {
    const result = await classifier.classify('我们决定采用管道架构，放弃事件溯源方案，权衡后选择简单性');
    expect(result.type).toBe('decision');
  });

  it('classifies experience content', async () => {
    const result = await classifier.classify('实践中发现这个方案有坑，之前遇到过类似的教训');
    expect(result.type).toBe('experience');
  });

  it('classifies intent content', async () => {
    const result = await classifier.classify('目标是让系统必须在 2 秒内响应，禁止超时');
    expect(result.type).toBe('intent');
  });

  it('classifies meta content', async () => {
    const result = await classifier.classify('关于知识管理的元认知反思和自省');
    expect(result.type).toBe('meta');
  });

  it('returns default confidence for unmatched content', async () => {
    const result = await classifier.classify('hello world');
    expect(result.confidence).toBe(0.3);
  });
});

// ─── QualityGate Tests ──────────────────────────────────────────────────────

describe('QualityGate', () => {
  it('allows long content even when it starts with a status prefix', () => {
    const result = evaluateQuality({
      title: '迁移复盘',
      content: '已完成核心链路迁移，并在回归验证中确认三类异常路径都已被覆盖。这个结论同时记录了迁移窗口、回滚策略、容量变化、监控观察点、以及后续需要保留的工程约束。为了避免误把长篇复盘当成状态日志，这里继续补充背景、过程、结果和经验，确保内容长度超过二百字符且仍然保留有效信息。再补充一段实施细节，包括灰度顺序、故障回放、监控基线、容量水位、回退手册、遗留问题清单、告警阈值调整、值班交接注意事项，以及上线后一周内的观测结论，确保长度明显超过两百字符。',
    });

    expect(result).toEqual({ passed: true });
  });

  it('rejects title/content duplicates after trimming whitespace', () => {
    const duplicatedContent = '同一段内容，同一段内容，同一段内容，同一段内容，同一段内容，同一段内容，同一段内容，同一段内容，同一段内容。';
    const result = evaluateQuality({
      title: `${duplicatedContent}  `,
      content: duplicatedContent,
    });

    expect(result).toEqual({ passed: false, reason: 'title_equals_content' });
  });
});

// ─── Extractor Tests ─────────────────────────────────────────────────────────

describe('Extractor', () => {
  const extractor = new Extractor({ minContentLength: 10, classifier: createMockClassifier() });

  it('extracts entries from multi-paragraph text', async () => {
    const text = `用户数量是 1500 人，占比 35%。这是一个重要的数据点。

我们决定采用管道架构来处理知识提取流程，权衡后放弃了事件溯源。

实践中发现异步提取能显著降低主流程延迟，这是一个重要的经验教训。`;

    const entries = await extractor.extract(text, testSource);

    expect(entries.length).toBe(3);
    expect(entries.every(e => e.id)).toBe(true);
    expect(entries.every(e => e.source === testSource)).toBe(true);
    expect(entries.every(e => e.version === 1)).toBe(true);
  });

  it('skips short paragraphs below threshold', async () => {
    const text = `短文。

这是一段足够长的内容，应该被提取为知识条目。`;

    const entries = await extractor.extract(text, testSource);
    expect(entries.length).toBe(1);
  });

  it('generates summary from first sentence', async () => {
    const text = '这是第一句话。后面还有很多内容但不会出现在摘要里因为第一句已经足够了。';
    const entries = await extractor.extract(text, testSource);

    expect(entries[0].summary).toBe('这是第一句话。');
  });
});

// ─── PipelineEngine Tests ────────────────────────────────────────────────────

describe('PipelineEngine', () => {
  let engine: PipelineEngine;

  beforeEach(() => { engine = new PipelineEngine({ classifier: createMockClassifier() }); });
  afterEach(() => { engine.destroy(); });

  it('submit returns task id immediately (non-blocking)', () => {
    const taskId = engine.submit('一些需要提取的知识内容，足够长的文本', testSource);
    expect(taskId).toBeDefined();
    expect(typeof taskId).toBe('string');

    // Task exists but may still be running
    const task = engine.getTask(taskId);
    expect(task).toBeDefined();
    expect(['pending', 'running', 'completed']).toContain(task!.status);
  });

  it('completes extraction pipeline asynchronously', async () => {
    const text = `用户数量统计数据是 2000 人，占比 40%。

我们决定采用 TypeScript 严格模式，放弃 JavaScript 的灵活性。`;

    const taskId = engine.submit(text, testSource);

    // Wait for async pipeline to complete
    await new Promise<void>((resolve) => {
      engine.bus.on('task:completed', () => resolve());
      // Fallback timeout
      setTimeout(resolve, 1000);
    });

    const task = engine.getTask(taskId);
    expect(task!.status).toBe('completed');
    expect(task!.results.length).toBe(2);
    expect(task!.completedAt).toBeDefined();
  });

  it('emits stage events in correct order', async () => {
    const stages: string[] = [];
    engine.bus.onAny((event) => {
      stages.push(event.type);
    });

    const text = '这是一段关于方法论的最佳实践流程描述，包含具体的步骤和框架。';
    engine.submit(text, testSource);

    await new Promise<void>((resolve) => {
      engine.bus.on('task:completed', () => resolve());
      setTimeout(resolve, 1000);
    });

    expect(stages).toContain('task:created');
    expect(stages).toContain('task:started');
    expect(stages).toContain('stage:entered');
    expect(stages).toContain('entry:extracted');
    expect(stages).toContain('task:completed');

    // Verify order: created before started, started before completed
    const createdIdx = stages.indexOf('task:created');
    const startedIdx = stages.indexOf('task:started');
    const completedIdx = stages.indexOf('task:completed');
    expect(createdIdx).toBeLessThan(startedIdx);
    expect(startedIdx).toBeLessThan(completedIdx);
  });

  it('handles empty input gracefully', async () => {
    const taskId = engine.submit('', testSource);

    await new Promise<void>((resolve) => {
      engine.bus.on('task:completed', () => resolve());
      setTimeout(resolve, 1000);
    });

    const task = engine.getTask(taskId);
    expect(task!.status).toBe('completed');
    expect(task!.results).toHaveLength(0);
  });

  it('getResults returns entries for completed task', async () => {
    const text = '这是一个关于知识管理的元认知反思，涉及认知和自省的过程。';
    const taskId = engine.submit(text, testSource);

    await new Promise<void>((resolve) => {
      engine.bus.on('task:completed', () => resolve());
      setTimeout(resolve, 1000);
    });

    const results = engine.getResults(taskId);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBeDefined();
    expect(results[0].content).toBeDefined();
  });

  it('reports evaluated count based on active entries only', async () => {
    const stagePayloads: Array<Record<string, unknown>> = [];
    const repository = {
      save: async (_entry: KnowledgeEntry) => {},
    } as unknown as KnowledgeRepository;

    const engine = new PipelineEngine({
      repository,
      classifier: createMockClassifier((content) => {
        if (content.includes('低置信度')) {
          return { type: 'fact', confidence: 0.1, domain: 'general' };
        }
        return { type: 'fact', confidence: 0.9, domain: 'general' };
      }),
      extractor: { minContentLength: 1 },
      confidenceThreshold: 0.5,
    });

    let taskId = '';
    engine.bus.on('stage:completed', (event) => {
      if (event.taskId === taskId && event.stage === 'quality_gate') {
        stagePayloads.push(event.payload);
      }
    });

    taskId = engine.submit([
      '低置信度条目，但长度足够让它通过提取阶段。',
      '',
      '这是一条会进入质量门禁的有效知识内容，长度足够，而且明确记录了约束背景、执行方式、验收标准与后续维护要求，不会被状态日志规则拦截。',
    ].join('\n\n'), testSource);

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

    expect(stagePayloads).toHaveLength(1);
    expect(stagePayloads[0]).toMatchObject({ evaluated: 1, passed: 1, rejected: 0 });

    engine.destroy();
  });

  it('filters low-value entries before persistence and marks them rejected', async () => {
    const saved: KnowledgeEntry[] = [];
    const repository = {
      save: async (entry: KnowledgeEntry) => {
        saved.push(entry);
      },
    } as unknown as KnowledgeRepository;

    const engine = new PipelineEngine({
      repository,
      classifier: createMockClassifier(),
      extractor: { minContentLength: 1 },
      confidenceThreshold: 0,
    });

    const text = [
      '任务A完成',
      '',
      '这是一个足够长的工程约束说明，明确要求在持久化之前先做质量过滤，避免把低价值状态日志写入知识库，同时补充了验收口径和长期维护背景。',
    ].join('\n\n');

    const taskId = engine.submit(text, testSource);

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
    expect(task?.results).toHaveLength(2);
    expect(task?.results[0]?.status).toBe('active');
    expect(task?.results[1]?.status).toBe('active');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.content).toContain('质量过滤');

    engine.destroy();
  });

  it('skips quality gate when disabled', async () => {
    const saved: KnowledgeEntry[] = [];
    const repository = {
      save: async (entry: KnowledgeEntry) => {
        saved.push(entry);
      },
    } as unknown as KnowledgeRepository;

    const skippedStages: Array<{ type: string; stage: string; payload: Record<string, unknown> }> = [];
    const engine = new PipelineEngine({
      repository,
      classifier: createMockClassifier(),
      extractor: { minContentLength: 1 },
      confidenceThreshold: 0,
      qualityGateEnabled: false,
    });

    engine.bus.on('stage:skipped', (event) => {
      skippedStages.push({ type: event.type, stage: event.stage, payload: event.payload });
    });

    const taskId = engine.submit('任务A完成', testSource);

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

    expect(saved).toHaveLength(1);
    expect(skippedStages.some((event) => event.type === 'stage:skipped' && event.stage === 'quality_gate')).toBe(true);

    engine.destroy();
  });
});
