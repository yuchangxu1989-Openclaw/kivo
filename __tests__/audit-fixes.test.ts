/**
 * Tests for Wave 1 Audit Fix — 4 blocking items
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PipelineEngine } from '../src/pipeline/engine.js';
import { Extractor } from '../src/pipeline/extractor.js';
import { SQLiteProvider } from '../src/repository/sqlite-provider.js';
import { ConflictDetector } from '../src/conflict/index.js';
import type { KnowledgeEntry, KnowledgeSource, EntryStatus } from '../src/types/index.js';
import type { LLMJudgeProvider } from '../src/conflict/spi.js';
import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testSource: KnowledgeSource = {
  type: 'conversation',
  reference: 'test://audit-fix',
  timestamp: new Date(),
  agent: 'test-agent',
};

// ─── Fix 1: PipelineEngine conflict_detection calls ConflictDetector ─────────

describe('Fix 1: PipelineEngine conflict_detection', () => {
  it('calls ConflictDetector.detect when detector is provided', async () => {
    const detectCalls: KnowledgeEntry[] = [];
    const mockLLM: LLMJudgeProvider = {
      judgeConflict: async () => 'no_conflict',
    };
    const detector = new ConflictDetector({ llmJudgeProvider: mockLLM });
    const originalDetect = detector.detect.bind(detector);
    detector.detect = async (incoming, existing) => {
      detectCalls.push(incoming);
      return originalDetect(incoming, existing);
    };

    const engine = new PipelineEngine({ conflictDetector: detector });

    const text = '这是一段关于知识管理的重要事实数据，用户数量 3000 人。';
    const taskId = engine.submit(text, testSource);

    await new Promise<void>((resolve) => {
      engine.bus.on('task:completed', () => resolve());
      setTimeout(resolve, 2000);
    });

    expect(detectCalls.length).toBeGreaterThan(0);
    engine.destroy();
  });

  it('skips conflict_detection when no detector provided (backward compat)', async () => {
    const engine = new PipelineEngine(); // no conflictDetector
    const events: string[] = [];
    engine.bus.onAny((e) => { events.push(`${e.type}:${e.stage}`); });

    const text = '这是一段足够长的测试文本，用于验证管道流程正常完成。';
    engine.submit(text, testSource);

    await new Promise<void>((resolve) => {
      engine.bus.on('task:completed', () => resolve());
      setTimeout(resolve, 2000);
    });

    // conflict_detection stage still entered and completed (just no actual detection)
    expect(events).toContain('stage:entered:conflict_detection');
    expect(events).toContain('stage:completed:conflict_detection');
    engine.destroy();
  });
});

// ─── Fix 2: EntryStatus includes deprecated and pending ─────────────────────

describe('Fix 2: EntryStatus deprecated/pending', () => {
  it('accepts deprecated and pending as valid EntryStatus values', () => {
    const statuses: EntryStatus[] = ['active', 'superseded', 'archived', 'draft', 'deprecated', 'pending'];
    // TypeScript compilation itself validates this; runtime check for completeness
    expect(statuses).toContain('deprecated');
    expect(statuses).toContain('pending');
  });
});

// ─── Fix 3: SQLiteProvider.search() respects filters ─────────────────────────

describe('Fix 3: SQLiteProvider.search() filters', () => {
  let provider: SQLiteProvider;
  const dbPath = join(tmpdir(), `kivo-test-filters-${randomUUID()}.db`);

  beforeEach(async () => {
    provider = new SQLiteProvider({ dbPath });
    // Seed entries
    const base = {
      summary: 'test summary',
      source: testSource,
      tags: [],
      version: 1,
      createdAt: new Date('2025-01-15'),
      updatedAt: new Date('2025-01-15'),
    };
    await provider.save({ ...base, id: 'e1', type: 'fact', title: 'fact about users', content: 'user count is 1500', confidence: 0.9, status: 'active', domain: 'analytics' });
    await provider.save({ ...base, id: 'e2', type: 'decision', title: 'decision about architecture', content: 'we decided to use pipeline architecture', confidence: 0.8, status: 'active', domain: 'engineering' });
    await provider.save({ ...base, id: 'e3', type: 'fact', title: 'fact about revenue', content: 'revenue is growing for users', confidence: 0.7, status: 'archived', domain: 'analytics' });
  });

  afterEach(async () => {
    await provider.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('filters by type', async () => {
    const results = await provider.search({ text: 'users', filters: { types: ['fact'] } });
    expect(results.every(r => r.entry.type === 'fact')).toBe(true);
    expect(results.some(r => r.entry.id === 'e1')).toBe(true);
  });

  it('filters by status', async () => {
    const results = await provider.search({ text: 'users', filters: { status: ['archived'] } });
    expect(results.every(r => r.entry.status === 'archived')).toBe(true);
  });

  it('filters by domain', async () => {
    const results = await provider.search({ text: 'architecture', filters: { domain: 'engineering' } });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.entry.domain === 'engineering')).toBe(true);
  });

  it('returns filter-only results when no text query', async () => {
    const results = await provider.search({ text: '', filters: { types: ['fact'], status: ['active'] } });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.entry.type === 'fact' && r.entry.status === 'active')).toBe(true);
  });
});

// ─── Fix 4: Extractor minConfidence threshold ────────────────────────────────

describe('Fix 4: Extractor minConfidence threshold', () => {
  it('marks low-confidence entries as pending', async () => {
    // Use a high threshold so most entries fall below
    const extractor = new Extractor({ minContentLength: 10, minConfidence: 0.9 });
    const text = 'hello world this is some generic text that the classifier will not be very confident about';
    const entries = await extractor.extract(text, testSource);

    // Default classifier gives 0.3 for unmatched content → below 0.9 threshold
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(e => e.status === 'pending')).toBe(true);
  });

  it('marks high-confidence entries as active', async () => {
    // Use default threshold (0.3)
    const extractor = new Extractor({ minContentLength: 10, minConfidence: 0.3 });
    const text = '用户数量是 1500 人，占比 35%。这是一个重要的数据点和统计事实。';
    const entries = await extractor.extract(text, testSource);

    expect(entries.length).toBeGreaterThan(0);
    // Classifier gives higher confidence for fact-like content
    expect(entries.some(e => e.status === 'active')).toBe(true);
  });

  it('uses 0.3 as default minConfidence', async () => {
    const extractor = new Extractor({ minContentLength: 10 });
    // Unmatched content gets exactly 0.3 confidence from classifier
    const text = 'hello world this is some generic text without any knowledge signals';
    const entries = await extractor.extract(text, testSource);

    // 0.3 is NOT less than 0.3, so should be 'active'
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(e => e.status === 'active')).toBe(true);
  });
});
