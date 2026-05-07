import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryKnowledgeStore } from '../src/storage/index.js';
import { DictionaryService, TermConflictChecker, TermImporter, TermInjectionStrategy } from '../src/dictionary/index.js';
import { ConflictDetector } from '../src/conflict/index.js';
import type { KnowledgeSource } from '../src/types/index.js';
import type { LLMJudgeProvider } from '../src/conflict/spi.js';

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'test://dictionary',
  timestamp: new Date(),
};

const llm: LLMJudgeProvider = {
  async judgeConflict() {
    return 'conflict';
  },
};

describe('Dictionary Batch 4', () => {
  let store: MemoryKnowledgeStore;
  let service: DictionaryService;
  let importer: TermImporter;

  beforeEach(() => {
    store = new MemoryKnowledgeStore();
    service = new DictionaryService({
      store,
      conflictChecker: new TermConflictChecker({
        conflictDetector: new ConflictDetector({ llmJudgeProvider: llm }),
      }),
    });
    importer = new TermImporter({ dictionaryService: service });
  });

  it('registers governanceSource in metadata', async () => {
    const entry = await service.register({
      term: 'Intent Routing',
      definition: '必须用 LLM 做意图理解。',
      scope: ['intent'],
      source: testSource,
      governanceSource: 'AGENTS.md',
    });

    expect((entry.metadata as Record<string, unknown>).governanceSource).toBe('AGENTS.md');
  });

  it('injects deprecated warning with replacement term id and obeys token budget', async () => {
    const replacement = await service.register({
      term: 'New Term',
      definition: 'new definition',
      scope: ['system'],
      source: testSource,
    });
    const deprecated = await service.register({
      term: 'Old Term',
      definition: 'old definition',
      scope: ['system'],
      source: testSource,
    });

    await service.deprecate(deprecated.id, 'renamed', replacement.id);

    const strategy = new TermInjectionStrategy({
      store,
      config: { injection: { priorityBoost: 2, maxTokens: 50 } },
    });

    const result = await strategy.getTermBlocks('Old Term and New Term', { tokenBudget: 20 });
    expect(result.deprecatedWarnings[0].text).toContain(replacement.id);
    expect(result.blocks.length).toBeLessThanOrEqual(1);
  });

  it('marks merged source term with replacement target for rollback-safe supersede', async () => {
    const source = await service.register({
      term: 'Old Concept',
      definition: 'old',
      scope: ['system'],
      source: testSource,
    });
    const target = await service.register({
      term: 'New Concept',
      definition: 'new',
      scope: ['system'],
      source: testSource,
    });

    await service.merge([source.id], target.id);
    const merged = await store.get(source.id);

    expect(merged?.status).toBe('active');
    expect((merged?.metadata as Record<string, unknown>).deprecationReplacementTermId).toBe(target.id);
  });

  it('imports terms from governance content', async () => {
    const report = await importer.importFromGovernanceContent(
      `## 术语：意图路由\n- 定义: 必须由 LLM 推理链路处理。\n- 约束: 禁止关键词匹配\n- 别名: intent routing\n- 适用域: intent,governance`,
      testSource,
    );

    expect(report.succeeded).toBe(1);
    const entry = await service.getByTerm('意图路由', 'intent');
    expect(entry).not.toBeNull();
    expect((entry?.metadata as Record<string, unknown>).governanceSource).toBe('heading');
  });
});
