import { describe, expect, it, vi } from 'vitest';
import { ContextInjector, Disambiguator } from '../src/intent/index.js';
import { KnowledgeRepository } from '../src/repository/knowledge-repository.js';
import type { SearchResult, SemanticQuery, StorageProvider } from '../src/repository/storage-provider.js';
import type { LLMProvider } from '../src/adapter/llm-provider.js';
import type { KnowledgeEntry } from '../src/types/index.js';

function makeEntry(overrides: Partial<KnowledgeEntry> & { id: string }): KnowledgeEntry {
  return {
    id: overrides.id,
    type: 'fact',
    title: 'Default entry',
    content: 'default content',
    summary: 'default summary',
    source: {
      type: 'manual',
      reference: 'unit-test',
      timestamp: new Date('2026-04-20T00:00:00.000Z'),
    },
    confidence: 0.8,
    status: 'active',
    tags: [],
    createdAt: new Date('2026-04-20T00:00:00.000Z'),
    updatedAt: new Date('2026-04-20T00:00:00.000Z'),
    version: 1,
    ...overrides,
  };
}

class MockStorageProvider implements StorageProvider {
  constructor(private readonly results: SearchResult[]) {}

  async save(): Promise<void> {}
  async findById(id: string): Promise<KnowledgeEntry | null> {
    return this.results.find((item) => item.entry.id === id)?.entry ?? null;
  }
  async search(query: SemanticQuery): Promise<SearchResult[]> {
    const filtered = this.results.filter((item) => {
      if (!query.filters?.types?.length) {
        return true;
      }
      return query.filters.types.includes(item.entry.type);
    });
    return filtered.slice(0, query.topK ?? filtered.length);
  }
  async updateStatus(): Promise<void> {}
  async getVersionHistory(): Promise<KnowledgeEntry[]> { return []; }
  async findByType(type: KnowledgeEntry['type']): Promise<KnowledgeEntry[]> {
    return this.results.filter((item) => item.entry.type === type).map((item) => item.entry);
  }
  async fullTextSearch(): Promise<KnowledgeEntry[]> { return []; }
  async findAll(): Promise<KnowledgeEntry[]> { return this.results.map((item) => item.entry); }
  async delete(): Promise<void> {}
  async count(): Promise<number> { return this.results.length; }
  async close(): Promise<void> {}
}

describe('intent/ContextInjector', () => {
  it('sorts by relevance and trims to token budget with source labels', async () => {
    const repository = new KnowledgeRepository(new MockStorageProvider([
      {
        entry: makeEntry({
          id: 'decision-1',
          type: 'decision',
          title: '默认优先走飞书文档',
          summary: '长报告先产出飞书文档，再补摘要。',
          source: {
            type: 'conversation',
            reference: 'memory://decision/feishu',
            agent: 'pm-01',
            timestamp: new Date('2026-04-20T08:00:00.000Z'),
          },
        }),
        score: 0.95,
      },
      {
        entry: makeEntry({
          id: 'intent-1',
          type: 'intent',
          title: '用户偏好短答',
          summary: '先给结论，再补证据，少说套话。',
          source: {
            type: 'manual',
            reference: 'user://profile',
            timestamp: new Date('2026-04-20T08:10:00.000Z'),
          },
        }),
        score: 0.8,
      },
      {
        entry: makeEntry({
          id: 'fact-1',
          type: 'fact',
          title: '次要事实',
          summary: '这条知识相关，但预算不够时应该被裁掉。'.repeat(20),
          source: {
            type: 'document',
            reference: 'doc://fact-1',
            timestamp: new Date('2026-04-20T08:20:00.000Z'),
          },
        }),
        score: 0.6,
      },
    ]));

    const injector = new ContextInjector({ repository, defaultLimit: 5 });
    const result = await injector.inject({
      query: '长报告怎么交付',
      tokenBudget: 60,
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].entryId).toBe('decision-1');
    expect(result.entries[0].source.label).toContain('conversation');
    expect(result.entries[0].source.label).toContain('memory://decision/feishu');
    expect(result.entries[0].source.label).toContain('agent:pm-01');
    expect(result.totalTokens).toBeLessThanOrEqual(60);
    expect(result.truncated).toBe(true);
  });

  it('keeps user request untouched and supports type filtering', async () => {
    const repository = new KnowledgeRepository(new MockStorageProvider([
      {
        entry: makeEntry({
          id: 'decision-2',
          type: 'decision',
          title: '产品方向',
          summary: '沿用既有方向。',
        }),
        score: 0.9,
      },
      {
        entry: makeEntry({
          id: 'fact-2',
          type: 'fact',
          title: '事实条目',
          summary: '普通事实。',
        }),
        score: 0.95,
      },
    ]));

    const injector = new ContextInjector({ repository });
    const request = {
      query: '继续推进这个方向',
      tokenBudget: 80,
      preferredTypes: ['decision' as const],
    };

    const result = await injector.inject(request);

    expect(request.query).toBe('继续推进这个方向');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe('decision');
  });
});

describe('intent/Disambiguator', () => {
  it('prefers decision and intent evidence, returning confidence and evidence', async () => {
    const repository = new KnowledgeRepository(new MockStorageProvider([
      {
        entry: makeEntry({
          id: 'decision-3',
          type: 'decision',
          title: '默认导出飞书文档',
          summary: '提到“发出去”时默认指发飞书文档链接。',
          confidence: 0.92,
        }),
        score: 0.93,
      },
      {
        entry: makeEntry({
          id: 'intent-3',
          type: 'intent',
          title: '用户偏好飞书交付',
          summary: '长文档优先走飞书，不直接扔服务器路径。',
          confidence: 0.88,
        }),
        score: 0.82,
      },
    ]));

    const llmProvider: LLMProvider = {
      complete: vi.fn().mockResolvedValue(JSON.stringify({
        interpretations: [
          {
            meaning: '这个结果发出去 更可能对应既有决策：发飞书文档链接。',
            confidence: 0.91,
            evidenceIds: ['decision-3'],
          },
        ],
        selectedIndex: 0,
      })),
    };

    const disambiguator = new Disambiguator({ repository, llmProvider });
    const result = await disambiguate(disambiguator, {
      input: '这个结果发出去',
      confidenceThreshold: 0.6,
    });

    expect(result.selected).toBeDefined();
    expect(result.selected?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.selected?.meaning).toContain('发出去');
    expect(result.selected?.evidence[0]?.entryId).toBe('decision-3');
    expect(result.clarification).toBeUndefined();
    expect(result.resolutionMode).toBe('llm');
  });

  it('returns structured clarification instead of guessing on low confidence', async () => {
    const repository = new KnowledgeRepository(new MockStorageProvider([
      {
        entry: makeEntry({
          id: 'fact-4',
          type: 'fact',
          title: '模糊背景A',
          summary: '可能是目标对象。',
          confidence: 0.45,
        }),
        score: 0.42,
      },
      {
        entry: makeEntry({
          id: 'experience-4',
          type: 'experience',
          title: '模糊背景B',
          summary: '也可能是执行动作。',
          confidence: 0.44,
        }),
        score: 0.41,
      },
    ]));

    const disambiguator = new Disambiguator({ repository });
    const result = await disambiguate(disambiguator, {
      input: '按之前那个来',
      confidenceThreshold: 0.7,
    });

    expect(result.selected).toBeUndefined();
    expect(result.clarification).toBeDefined();
    expect(result.clarification?.question).toContain('按之前那个来');
    expect(result.clarification?.options.length).toBeGreaterThan(0);
    expect(result.clarification?.evidence.length).toBeGreaterThan(0);
    expect(result.resolutionMode).toBe('fallback');
    expect(result.fallbackReason).toContain('未配置 LLM');
  });

  it('falls back explicitly when llm inference fails', async () => {
    const repository = new KnowledgeRepository(new MockStorageProvider([
      {
        entry: makeEntry({
          id: 'decision-fallback',
          type: 'decision',
          title: '默认走文档',
          summary: '按之前那个来通常指沿用上次文档流程。',
          confidence: 0.85,
        }),
        score: 0.84,
      },
    ]));

    const disambiguator = new Disambiguator({
      repository,
      llmProvider: {
        complete: vi.fn().mockRejectedValue(new Error('provider timeout')),
      },
    });

    const result = await disambiguate(disambiguator, {
      input: '按之前那个来',
      confidenceThreshold: 0.5,
    });

    expect(result.resolutionMode).toBe('fallback');
    expect(result.fallbackReason).toContain('LLM 消歧失败');
    expect(result.selected?.evidence[0]?.entryId).toBe('decision-fallback');
  });
});

async function disambiguate(
  disambiguator: Disambiguator,
  request: Parameters<Disambiguator['disambiguate']>[0]
) {
  return disambiguator.disambiguate(request);
}
