import { describe, expect, it, vi } from 'vitest';
import {
  DomainGoalStore,
  checkExtractionBoundary,
  boostByDomainGoal,
  detectGaps,
  buildResearchConstraint,
} from '../src/domain-goal/index.js';
import type { DomainGoal, DomainGoalChangeEvent } from '../src/domain-goal/index.js';
import type { KnowledgeEntry } from '../src/types/index.js';

// ── Helper ──

function makeGoal(overrides?: Partial<DomainGoal>): DomainGoal {
  return {
    domainId: 'test-domain',
    purpose: 'AI Agent 知识管理与迭代',
    keyQuestions: ['如何提取知识', '如何检测冲突', '如何语义搜索'],
    nonGoals: ['前端 UI 设计', '数据库运维'],
    researchBoundary: '限于 Agent 知识管理领域，不涉及通用 NLP 研究',
    prioritySignals: ['知识提取', '冲突检测', '语义搜索'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeEntry(overrides?: Partial<KnowledgeEntry>): KnowledgeEntry {
  return {
    id: 'e-1',
    type: 'fact',
    title: '知识提取流程',
    content: '知识提取通过 Pipeline 分段处理文本，提取结构化知识条目。',
    summary: '知识提取流程说明',
    source: { type: 'manual', reference: 'test', timestamp: new Date() },
    confidence: 0.9,
    status: 'active',
    tags: ['extraction'],
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

// ── FR-M01: DomainGoalStore ──

describe('DomainGoalStore', () => {
  it('creates a domain goal with all fields (AC1)', () => {
    const store = new DomainGoalStore();
    const goal = store.create({
      domainId: 'ai-knowledge',
      purpose: 'AI 知识管理',
      keyQuestions: ['如何提取', '如何检索'],
      nonGoals: ['UI 设计'],
      researchBoundary: '限于 AI 领域',
      prioritySignals: ['知识提取'],
    });

    expect(goal.domainId).toBe('ai-knowledge');
    expect(goal.purpose).toBe('AI 知识管理');
    expect(goal.keyQuestions).toEqual(['如何提取', '如何检索']);
    expect(goal.nonGoals).toEqual(['UI 设计']);
    expect(goal.researchBoundary).toBe('限于 AI 领域');
    expect(goal.prioritySignals).toEqual(['知识提取']);
    expect(goal.createdAt).toBeInstanceOf(Date);
    expect(goal.updatedAt).toBeInstanceOf(Date);
  });

  it('creates with default empty arrays for optional fields', () => {
    const store = new DomainGoalStore();
    const goal = store.create({ domainId: 'minimal', purpose: 'test' });
    expect(goal.keyQuestions).toEqual([]);
    expect(goal.nonGoals).toEqual([]);
    expect(goal.prioritySignals).toEqual([]);
    expect(goal.researchBoundary).toBe('');
  });

  it('rejects duplicate domainId', () => {
    const store = new DomainGoalStore();
    store.create({ domainId: 'd1', purpose: 'test' });
    expect(() => store.create({ domainId: 'd1', purpose: 'test2' })).toThrow('already exists');
  });

  it('updates a domain goal (AC2)', () => {
    const store = new DomainGoalStore();
    store.create({ domainId: 'd1', purpose: 'original' });
    const updated = store.update('d1', { purpose: 'updated' });
    expect(updated?.purpose).toBe('updated');
  });

  it('returns null when updating non-existent goal', () => {
    const store = new DomainGoalStore();
    expect(store.update('nope', { purpose: 'x' })).toBeNull();
  });

  it('deletes a domain goal (AC2)', () => {
    const store = new DomainGoalStore();
    store.create({ domainId: 'd1', purpose: 'test' });
    expect(store.delete('d1')).toBe(true);
    expect(store.get('d1')).toBeNull();
  });

  it('returns false when deleting non-existent goal', () => {
    const store = new DomainGoalStore();
    expect(store.delete('nope')).toBe(false);
  });

  it('lists all goals', () => {
    const store = new DomainGoalStore();
    store.create({ domainId: 'd1', purpose: 'a' });
    store.create({ domainId: 'd2', purpose: 'b' });
    expect(store.list()).toHaveLength(2);
  });

  it('emits change events on create/update/delete (AC3)', () => {
    const store = new DomainGoalStore();
    const events: DomainGoalChangeEvent[] = [];
    store.onChange(e => events.push(e));

    store.create({ domainId: 'd1', purpose: 'test' });
    store.update('d1', { purpose: 'updated' });
    store.delete('d1');

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('created');
    expect(events[1].type).toBe('updated');
    expect(events[1].previous?.purpose).toBe('test');
    expect(events[1].current?.purpose).toBe('updated');
    expect(events[2].type).toBe('deleted');
    expect(events[2].previous?.purpose).toBe('updated');
  });

  it('unsubscribe removes listener', () => {
    const store = new DomainGoalStore();
    const events: DomainGoalChangeEvent[] = [];
    const unsub = store.onChange(e => events.push(e));

    store.create({ domainId: 'd1', purpose: 'test' });
    unsub();
    store.create({ domainId: 'd2', purpose: 'test2' });

    expect(events).toHaveLength(1);
  });

  it('has() checks existence', () => {
    const store = new DomainGoalStore();
    store.create({ domainId: 'd1', purpose: 'test' });
    expect(store.has('d1')).toBe(true);
    expect(store.has('d2')).toBe(false);
  });
});

// ── FR-M02: Domain Goal Constraints ──

describe('checkExtractionBoundary (AC1)', () => {
  const goal = makeGoal();

  it('marks content matching priority signals as in-scope', () => {
    const result = checkExtractionBoundary('知识提取的最佳实践', goal);
    expect(result.inScope).toBe(true);
    expect(result.matchedSignals.length).toBeGreaterThan(0);
  });

  it('marks content matching nonGoals as out-of-scope', () => {
    const result = checkExtractionBoundary('前端 UI 设计的最新趋势和数据库运维方案', goal);
    expect(result.inScope).toBe(false);
  });

  it('defaults to in-scope when no signals match', () => {
    const result = checkExtractionBoundary('完全无关的天气预报内容', goal);
    expect(result.inScope).toBe(true);
    expect(result.reason).toContain('默认保留');
  });
});

describe('boostByDomainGoal (AC2)', () => {
  const goal = makeGoal();

  it('boosts entries matching keyQuestions', () => {
    const entry = makeEntry({ title: '如何提取知识', content: '知识提取方法论' });
    const results = boostByDomainGoal([{ entry, score: 0.5 }], goal);
    expect(results[0].boostedScore).toBeGreaterThan(0.5);
    expect(results[0].matchedQuestions.length).toBeGreaterThan(0);
  });

  it('does not boost unrelated entries', () => {
    const entry = makeEntry({ title: '天气预报', content: '明天晴天' });
    const results = boostByDomainGoal([{ entry, score: 0.5 }], goal);
    expect(results[0].boostedScore).toBe(0.5);
    expect(results[0].matchedQuestions).toHaveLength(0);
  });

  it('caps boost at 1.0', () => {
    const entry = makeEntry({ title: '如何提取知识和检测冲突以及语义搜索', content: '全部匹配' });
    const results = boostByDomainGoal([{ entry, score: 0.9 }], goal);
    expect(results[0].boostedScore).toBeLessThanOrEqual(1.0);
  });
});

describe('detectGaps (AC3)', () => {
  const goal = makeGoal();

  it('identifies covered and uncovered questions', () => {
    const entries = [
      makeEntry({ title: '知识提取方法', content: '如何提取知识的详细说明' }),
    ];
    const gaps = detectGaps(entries, goal);
    const covered = gaps.filter(g => g.covered);
    const uncovered = gaps.filter(g => !g.covered);
    expect(covered.length).toBeGreaterThan(0);
    expect(uncovered.length).toBeGreaterThan(0);
  });

  it('all uncovered when no entries', () => {
    const gaps = detectGaps([], goal);
    expect(gaps.every(g => !g.covered)).toBe(true);
  });
});

describe('buildResearchConstraint (AC4)', () => {
  it('builds constraint from domain goal', () => {
    const goal = makeGoal();
    const constraint = buildResearchConstraint(goal);
    expect(constraint.domainId).toBe('test-domain');
    expect(constraint.boundary).toBe(goal.researchBoundary);
    expect(constraint.focusQuestions).toEqual(goal.keyQuestions);
    expect(constraint.excludeTopics).toEqual(goal.nonGoals);
  });
});
