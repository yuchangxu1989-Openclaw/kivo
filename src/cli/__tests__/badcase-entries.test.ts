import { describe, expect, it } from 'vitest';
import {
  extractBadcasesFromResetJsonl,
  intentsToKnowledgeEntries,
  type ExtractedIntent,
} from '../badcase-extractor.js';

describe('B-class badcase entries extraction', () => {
  it('extracts substantive failure candidates from reset JSONL sessions with provenance', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-24T01:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '先看一下这个项目状态。' }] },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-24T01:01:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '这是 badcase：审计发现任务完成但没有写报告，必须修复并补验证。' }],
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-24T01:02:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '收到，我会补报告。' }],
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-24T01:03:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '验证失败：entries.subject_id 没写入，必须补齐 INSERT 字段并跑测试。' }],
        },
      }),
    ].join('\n');

    const badcases = await extractBadcasesFromResetJsonl(jsonl, '/tmp/session.jsonl.reset.1', { limit: 10 });

    expect(badcases).toHaveLength(2);
    expect(badcases[0].sourceType).toBe('audit_finding');
    expect(badcases[0].sessionId).toBe('session.jsonl.reset.1');
    expect(badcases[0].lineNumber).toBe(2);
    expect(badcases[0].context).toContain('审计发现任务完成但没有写报告');
    expect(badcases[1].sourceType).toBe('verification_failure');
  });

  it('converts extracted intents to KnowledgeEntry with subject_id inherited from material', () => {
    const intents: ExtractedIntent[] = [
      {
        title: '失败案例必须验证',
        content: '发现实质失败后必须补验证证据。',
        scenario: '任务 completion 后',
        triggerCondition: '发现 output 不完整或缺报告',
        expectedBehavior: '补齐验证并写报告',
        antiPattern: '只口头说完成',
        confidence: 0.93,
        tags: ['badcase', 'verification'],
        similarSentences: ['这个任务没验证', '报告没有写'],
        sourceType: 'verification_failure',
        sourceDate: '2026-05-24',
        sourceFilePath: '/tmp/session.jsonl.reset.1',
        sourceSessionId: 'session.jsonl.reset.1',
        sourceLineNumber: 4,
        sourceContext: 'user: 验证失败：entries.subject_id 没写入，必须补齐 INSERT 字段并跑测试。',
      },
    ];

    const entries = intentsToKnowledgeEntries(intents, {
      materialId: 'material-badcase-001',
      subjectId: 'subject-kivo-001',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('intent');
    expect(entries[0].subjectId).toBe('subject-kivo-001');
    expect(entries[0].source.materialId).toBe('material-badcase-001');
    expect(entries[0].source.subjectId).toBe('subject-kivo-001');
    expect(entries[0].metadata?.sourceBadcase).toMatchObject({
      materialId: 'material-badcase-001',
      sessionId: 'session.jsonl.reset.1',
      lineNumber: 4,
    });
  });
});
