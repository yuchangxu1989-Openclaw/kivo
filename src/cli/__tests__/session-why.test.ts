import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildSessionExtractionPrompt } from '../session-knowledge-llm.js';
import { normalizeAggregatedItem, type AggregatedKnowledgeItem } from '../session-knowledge-aggregator.js';
import { SQLiteProvider } from '../../repository/sqlite-provider.js';
import type { KnowledgeEntry } from '../../types/index.js';

describe('session extraction why field', () => {
  it('defines content/description and why as distinct prompt fields', () => {
    const prompt = buildSessionExtractionPrompt([
      {
        session_id: 's1',
        timestamp: '2026-06-09T10:00:00.000Z',
        text: '审计发现只分析不修复会导致失败项反复遗留。',
      },
    ]);

    expect(prompt).toContain('content/description 必须是这条候选素材的核心内容概述');
    expect(prompt).toContain('why 必须是独立的记录理由');
    expect(prompt).toContain('why 禁止复制 content/description/summary/title');
    expect(prompt).toContain('不能和 content 相同');
  });

  it('drops generated why when it duplicates content', () => {
    const item: AggregatedKnowledgeItem = {
      title: '失败项修复闭环',
      content: '扫描发现失败项后必须进入修复闭环。',
      why: '扫描发现失败项后必须进入修复闭环。',
      nature: 'methodology',
      function: 'principle',
      domain: 'quality',
      source: 'session-aggregate',
      confidence: 0.9,
      materialIds: ['m1'],
      sourceRefs: [],
    };

    expect(normalizeAggregatedItem(item).why).toBeUndefined();
  });

  it('persists independent why separately from content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kivo-why-'));
    const dbPath = join(dir, 'kivo.db');
    const provider = new SQLiteProvider({ dbPath, configDir: dir });
    const now = new Date('2026-06-09T10:00:00.000Z');
    const entry: KnowledgeEntry = {
      id: 'entry-why-1',
      type: 'methodology',
      title: '失败项修复闭环',
      content: '扫描发现失败项后必须进入修复闭环。',
      why: '该知识用于避免审计发现失败项后只分析不实施修复。',
      summary: '扫描发现失败项后必须进入修复闭环。',
      source: { type: 'conversation', reference: 'test://session', timestamp: now },
      confidence: 0.95,
      status: 'active',
      tags: ['why'],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    try {
      expect(await provider.save(entry, { skipQualityGate: true, skipEmbedding: true, skipDedup: true })).toBe(true);
      const saved = await provider.findById(entry.id);
      expect(saved?.content).toBe(entry.content);
      expect(saved?.why).toBe(entry.why);
      expect(saved?.why).not.toBe(saved?.content);
    } finally {
      await provider.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
