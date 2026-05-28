import { describe, expect, it } from 'vitest';
import { ConversationExtractor } from '../conversation-extractor.js';
import { DocumentExtractor } from '../document-extractor.js';
import { RuleExtractor } from '../rule-extractor.js';
import type { KnowledgeSource } from '../../types/index.js';

const source: KnowledgeSource = {
  type: 'document',
  reference: 'material:mat-001',
  timestamp: new Date('2026-05-24T00:00:00.000Z'),
  materialId: 'mat-001',
  subjectId: 'subject-node-42',
};

describe('FR-B03 AC7 subject propagation in extraction entries', () => {
  it('conversation extractor copies source.subjectId into entries.subjectId', async () => {
    const extractor = new ConversationExtractor({
      llmProvider: {
        complete: async () => JSON.stringify([
          {
            type: 'intent',
            title: '失败案例必须写报告',
            content: '当任务属于失败案例修复时，必须写入报告并验证。',
            summary: '失败案例修复要报告和验证',
            confidence: 0.91,
            tags: ['badcase'],
          },
        ]),
      },
    });

    const entries = await extractor.extract(
      [{ role: 'user', content: '失败案例修复必须写报告并验证。' }],
      source,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].subjectId).toBe('subject-node-42');
  });

  it('document extractor copies metadata.subjectId into LLM chunk entries', async () => {
    const extractor = new DocumentExtractor({
      minContentLength: 10,
      llmProvider: {
        complete: async () => JSON.stringify([
          {
            type: 'fact',
            title: 'Badcase 提取',
            content: 'B 类 entries 来自实质失败的 badcase 会话历史。',
            summary: 'B 类 entries 来源说明',
            confidence: 0.88,
            tags: ['badcase'],
          },
        ]),
      },
    });

    const entries = await extractor.extractFromMarkdown(
      '# B 类 entries\nB 类 entries 来自实质失败的 badcase 会话历史，需要继承材料学科。',
      { path: 'materials/badcase.md', title: 'B 类 entries', materialId: 'mat-002', subjectId: 'subject-node-meta' },
      { ...source, materialId: 'mat-002', subjectId: undefined },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].subjectId).toBe('subject-node-meta');
    expect(entries[0].source.materialId).toBe('mat-002');
  });

  it('rule extractor copies source.subjectId into rule knowledge entries', async () => {
    const extractor = new RuleExtractor();
    const rules = await extractor.extract('必须在收到 completion 后补发飞书消息。', source);
    const entries = extractor.toKnowledgeEntries(rules);

    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].subjectId).toBe('subject-node-42');
  });
});
