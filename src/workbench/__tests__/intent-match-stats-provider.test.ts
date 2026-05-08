import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryIntentMatchStatsProvider } from '../intent-match-stats-provider.js';

describe('InMemoryIntentMatchStatsProvider', () => {
  let provider: InMemoryIntentMatchStatsProvider;

  beforeEach(() => {
    provider = new InMemoryIntentMatchStatsProvider({ maxSnippets: 3 });
  });

  it('returns zero hits when no events recorded', async () => {
    const stats = await provider.getStats('intent-1', 30);
    expect(stats.last30DaysHits).toBe(0);
    expect(stats.typicalSnippets).toHaveLength(0);
  });

  it('counts hits within the time window', async () => {
    provider.recordMatch('intent-1', 'snippet A', 0.9);
    provider.recordMatch('intent-1', 'snippet B', 0.8);
    provider.recordMatch('intent-2', 'other intent', 0.7);

    const stats = await provider.getStats('intent-1', 30);
    expect(stats.last30DaysHits).toBe(2);
    expect(stats.typicalSnippets).toContain('snippet A');
    expect(stats.typicalSnippets).toContain('snippet B');
  });

  it('excludes events outside the time window', async () => {
    // Record a match, then backdate it
    provider.recordMatch('intent-1', 'old snippet', 0.9);
    const events = provider.getAllEvents();
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 45);
    (events[0] as { timestamp: Date }).timestamp = oldDate;

    provider.recordMatch('intent-1', 'recent snippet', 0.8);

    const stats = await provider.getStats('intent-1', 30);
    expect(stats.last30DaysHits).toBe(1);
    expect(stats.typicalSnippets).toEqual(['recent snippet']);
  });

  it('returns snippets sorted by confidence, deduplicated', async () => {
    provider.recordMatch('intent-1', 'low conf', 0.3);
    provider.recordMatch('intent-1', 'high conf', 0.95);
    provider.recordMatch('intent-1', 'mid conf', 0.7);
    provider.recordMatch('intent-1', 'high conf', 0.95); // duplicate

    const stats = await provider.getStats('intent-1', 30);
    expect(stats.last30DaysHits).toBe(4);
    expect(stats.typicalSnippets[0]).toBe('high conf');
    // Deduplicated: only 3 unique snippets
    expect(stats.typicalSnippets).toHaveLength(3);
  });

  it('respects maxSnippets limit', async () => {
    for (let i = 0; i < 10; i++) {
      provider.recordMatch('intent-1', `snippet ${i}`, 0.5 + i * 0.01);
    }
    const stats = await provider.getStats('intent-1', 30);
    expect(stats.typicalSnippets).toHaveLength(3);
  });

  it('prune removes old events', () => {
    provider.recordMatch('intent-1', 'old', 0.9);
    const events = provider.getAllEvents();
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    (events[0] as { timestamp: Date }).timestamp = oldDate;

    provider.recordMatch('intent-1', 'recent', 0.8);

    const pruned = provider.prune(30);
    expect(pruned).toBe(1);
    expect(provider.getAllEvents()).toHaveLength(1);
  });

  it('clear removes all events', () => {
    provider.recordMatch('intent-1', 'a', 0.9);
    provider.recordMatch('intent-1', 'b', 0.8);
    provider.clear();
    expect(provider.getAllEvents()).toHaveLength(0);
  });
});
