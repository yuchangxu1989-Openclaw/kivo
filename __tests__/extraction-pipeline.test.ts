import { describe, expect, it } from 'vitest';
import { ConversationExtractor } from '../src/extraction/conversation-extractor.js';
import { DocumentExtractor } from '../src/extraction/document-extractor.js';
import { ExtractionPipeline } from '../src/extraction/pipeline.js';
import { RuleExtractor } from '../src/extraction/rule-extractor.js';
import type { KnowledgeEntry, KnowledgeSource } from '../src/types/index.js';

const source: KnowledgeSource = {
  type: 'conversation',
  reference: 'test://conversation',
  timestamp: new Date('2026-04-20T00:00:00Z'),
};

describe('ConversationExtractor', () => {
  it('extracts structured knowledge from conversation messages', async () => {
    const extractor = new ConversationExtractor({
      llmProvider: {
        async complete() {
          return JSON.stringify([
            {
              type: 'decision',
              title: 'Use SQLite first',
              content: 'Wave 1 uses SQLite as the single source of truth for KIVO storage.',
              why: 'Without this storage decision, later pipeline code may split state across incompatible backends.',
              summary: 'Wave 1 stores KIVO data in SQLite.',
              confidence: 0.91,
              tags: ['storage', 'wave-1'],
            },
            {
              type: 'experience',
              title: 'Async extraction lowers latency',
              content: 'Async extraction keeps the main task responsive during ingestion.',
              summary: 'Async extraction protects main-task latency.',
              confidence: 0.84,
              tags: ['pipeline'],
            },
          ]);
        },
      },
    });

    const entries = await extractor.extract([
      { role: 'user', content: 'Wave 1 先用 SQLite，主流程别被提取拖慢。' },
      { role: 'assistant', content: '收到，我会保持异步提取。' },
    ], source);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      type: 'decision',
      title: 'Use SQLite first',
      why: 'Without this storage decision, later pipeline code may split state across incompatible backends.',
      status: 'active',
    });
    expect(entries[0].metadata?.domainData?.why).toBe('Without this storage decision, later pipeline code may split state across incompatible backends.');
    expect(entries[0].source.context).toContain('user:');
    expect(entries[1].tags).toContain('pipeline');
  });

  it('skips duplicates against existing entries', async () => {
    const extractor = new ConversationExtractor({
      llmProvider: {
        async complete() {
          return JSON.stringify([
            {
              type: 'decision',
              content: 'Wave 1 uses SQLite as the single source of truth for KIVO storage.',
              confidence: 0.9,
            },
          ]);
        },
      },
    });

    const existing: KnowledgeEntry[] = [{
      id: 'existing-1',
      type: 'decision',
      title: 'SQLite source of truth',
      content: 'Wave 1 uses SQLite as the single source of truth for KIVO storage.',
      summary: 'SQLite is the source of truth.',
      source,
      confidence: 0.95,
      status: 'active',
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
    }];

    const entries = await extractor.extract([
      { role: 'user', content: 'Wave 1 用 SQLite 作为单一真相源。' },
    ], source, existing);

    expect(entries).toHaveLength(0);
  });
});

describe('DocumentExtractor semantic path', () => {
  it('extracts document knowledge chunk by chunk through LLM provider', async () => {
    const extractor = new DocumentExtractor({
      minContentLength: 10,
      llmProvider: {
        async complete() {
          return JSON.stringify([
            {
              type: 'fact',
              title: 'Retrieval target',
              content: 'Knowledge retrieval should hit relevant entries within two seconds at P95.',
              why: 'This target matters because slow retrieval blocks timely context injection.',
              summary: 'Retrieval target is P95 within two seconds.',
              confidence: 0.88,
              tags: ['search'],
            },
          ]);
        },
      },
      chunkOptions: { maxTokens: 80 },
    });

    const markdown = `---\ntags: performance, search\ndomain: retrieval\n---\n\n# Search Goals\n\nKnowledge retrieval should hit relevant entries within two seconds at P95.`;

    const entries = await extractor.extractFromMarkdown(
      markdown,
      { path: 'docs/search-goals.md', title: 'Search Goals' },
      { ...source, type: 'document', reference: 'test://document' },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'fact',
      title: 'Retrieval target',
      why: 'This target matters because slow retrieval blocks timely context injection.',
      domain: 'retrieval',
    });
    expect(entries[0].metadata?.domainData?.why).toBe('This target matters because slow retrieval blocks timely context injection.');
    expect(entries[0].tags).toContain('search');
    expect(entries[0].source.context).toContain('docs/search-goals.md');
  });

  it('does not copy content into why when the LLM repeats the description', async () => {
    const repeated = 'Knowledge retrieval should hit relevant entries within two seconds at P95.';
    const extractor = new DocumentExtractor({
      minContentLength: 10,
      llmProvider: {
        async complete() {
          return JSON.stringify([
            {
              type: 'fact',
              title: 'Retrieval target',
              content: repeated,
              why: repeated,
              summary: 'Retrieval target is P95 within two seconds.',
              confidence: 0.88,
              tags: ['search'],
            },
          ]);
        },
      },
    });

    const entries = await extractor.extractFromMarkdown(
      '# Search Goals\n\nKnowledge retrieval should hit relevant entries within two seconds at P95.',
      { path: 'docs/search-goals.md', title: 'Search Goals' },
      { ...source, type: 'document', reference: 'test://document' },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].why).toBeUndefined();
    expect(entries[0].metadata?.domainData?.why).toBeUndefined();
  });
});

describe('RuleExtractor', () => {
  it('extracts rules heuristically without LLM', async () => {
    const extractor = new RuleExtractor();
    const rules = await extractor.extract(
      '涉及 openclaw.json 的修改必须先确认。\n禁止执行 openclaw doctor --fix。\n普通查询应该连续做完再汇报。',
      { ...source, type: 'system', reference: 'test://rules' },
    );

    expect(rules).toHaveLength(3);
    expect(rules[0]?.priority).toBe('high');
    expect(rules[1]?.priority).toBe('critical');
    expect(rules[2]?.directive).toContain('应该');

    const knowledge = extractor.toKnowledgeEntries(rules);
    expect(knowledge.every(entry => entry.type === 'intent')).toBe(true);
    expect(knowledge[1]?.tags).toContain('critical');
  });
});

describe('ExtractionPipeline', () => {
  it('orchestrates conversation, document, and rule extraction', async () => {
    const pipeline = new ExtractionPipeline({
      conversation: {
        llmProvider: {
          async complete() {
            return JSON.stringify([
              {
                type: 'decision',
                content: 'KIVO keeps core logic decoupled from the host runtime.',
                confidence: 0.92,
              },
            ]);
          },
        },
      },
      document: {
        llmProvider: {
          async complete() {
            return JSON.stringify([
              {
                type: 'methodology',
                content: 'Use pipeline-filter stages to separate extraction, conflict checks, and persistence.',
                confidence: 0.86,
              },
            ]);
          },
        },
        chunkOptions: { maxTokens: 80 },
      },
      rule: {},
    });

    const conversationResult = await pipeline.runConversationPipeline(
      { messages: [{ role: 'user', content: '核心逻辑要和宿主解耦。' }], source },
    );
    expect(conversationResult.orchestratorTaskId).toBeTruthy();
    expect(conversationResult.stages.map(stage => stage.stage)).toContain('decontextualization');
    expect(conversationResult.stages.map(stage => stage.stage)).toContain('abstract_aggregation');
    const conversationEntries = conversationResult.finalEntries;
    expect(conversationEntries).toHaveLength(1);

    const documentResult = await pipeline.runDocumentPipeline({
      markdown: '# Pipeline\n\nUse pipeline-filter stages to separate extraction, conflict checks, and persistence.',
      metadata: { path: 'docs/pipeline.md', title: 'Pipeline' },
      source: { ...source, type: 'document', reference: 'test://pipeline-doc' },
    });
    expect(documentResult.orchestratorTaskId).toBeTruthy();
    expect(documentResult.stages.map(stage => stage.stage)).toContain('extraction');
    expect(documentResult.stages.map(stage => stage.stage)).toContain('persistence');
    const documentEntries = documentResult.finalEntries;
    expect(documentEntries).toHaveLength(1);

    const ruleKnowledge = await pipeline.extractRuleKnowledge(
      '禁止跳过冲突检测直接写入知识库。',
      { ...source, type: 'system', reference: 'test://system-rules' },
    );
    expect(ruleKnowledge).toHaveLength(1);
    expect(ruleKnowledge[0]?.type).toBe('intent');
  });
});
