import { describe, expect, it } from 'vitest';
import {
  buildSidebar,
  getDefaultRoute,
  recommendActions,
  buildNavigationState,
  FIXED_NAV_ITEMS,
} from '../src/navigation/index.js';
import type { SystemStatus } from '../src/navigation/index.js';

function makeStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    pendingConflicts: 0,
    knowledgeGaps: 0,
    pendingReviews: 0,
    totalEntries: 10,
    onboardingComplete: true,
    ...overrides,
  };
}

// ── Sidebar Builder ──

describe('buildSidebar', () => {
  it('returns fixed nav items for clean status', () => {
    const sidebar = buildSidebar(makeStatus());
    expect(sidebar.length).toBe(FIXED_NAV_ITEMS.length);
    expect(sidebar.every((item) => !item.badge)).toBe(true);
  });

  it('adds conflict badge when pending conflicts exist', () => {
    const sidebar = buildSidebar(makeStatus({ pendingConflicts: 3 }));
    const conflicts = sidebar.find((i) => i.id === 'conflicts');
    expect(conflicts?.badge).toEqual({ count: 3, variant: 'warning' });
  });

  it('adds research badge for knowledge gaps', () => {
    const sidebar = buildSidebar(makeStatus({ knowledgeGaps: 5 }));
    const research = sidebar.find((i) => i.id === 'research');
    expect(research?.badge).toEqual({ count: 5, variant: 'info' });
  });

  it('adds knowledge badge for pending reviews', () => {
    const sidebar = buildSidebar(makeStatus({ pendingReviews: 2 }));
    const knowledge = sidebar.find((i) => i.id === 'knowledge');
    expect(knowledge?.badge).toEqual({ count: 2, variant: 'info' });
  });

  it('includes fixed entries for import, intent, dictionary', () => {
    const sidebar = buildSidebar(makeStatus());
    const ids = sidebar.map((i) => i.id);
    expect(ids).toContain('import');
    expect(ids).toContain('intent');
    expect(ids).toContain('dictionary');
  });
});

// ── Default Route ──

describe('getDefaultRoute', () => {
  it('returns dashboard when onboarding complete', () => {
    expect(getDefaultRoute(true)).toBe('/dashboard');
  });

  it('returns onboarding when not complete', () => {
    expect(getDefaultRoute(false)).toBe('/onboarding');
  });
});

// ── Dashboard Actions ──

describe('recommendActions', () => {
  it('returns empty for clean status', () => {
    expect(recommendActions(makeStatus())).toEqual([]);
  });

  it('recommends conflict review when conflicts exist', () => {
    const actions = recommendActions(makeStatus({ pendingConflicts: 2 }));
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('review-conflicts');
  });

  it('recommends research when gaps exist', () => {
    const actions = recommendActions(makeStatus({ knowledgeGaps: 3 }));
    expect(actions[0].type).toBe('start-research');
  });

  it('recommends import when knowledge base is empty', () => {
    const actions = recommendActions(makeStatus({ totalEntries: 0 }));
    expect(actions[0].type).toBe('import-documents');
    expect(actions[0].priority).toBe(0);
  });

  it('sorts by priority', () => {
    const actions = recommendActions(makeStatus({
      pendingConflicts: 1,
      knowledgeGaps: 2,
      pendingReviews: 3,
      totalEntries: 0,
    }));
    const priorities = actions.map((a) => a.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });
});

// ── Navigation Builder ──

describe('buildNavigationState', () => {
  it('builds complete navigation state', () => {
    const state = buildNavigationState(makeStatus({ pendingConflicts: 1 }));
    expect(state.sidebar.length).toBeGreaterThan(0);
    expect(state.dashboardActions).toHaveLength(1);
    expect(state.defaultRoute).toBe('/dashboard');
  });

  it('routes to onboarding when not complete', () => {
    const state = buildNavigationState(makeStatus({ onboardingComplete: false }));
    expect(state.defaultRoute).toBe('/onboarding');
  });
});
