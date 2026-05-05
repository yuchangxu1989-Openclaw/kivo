import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DashboardSummary, ApiResponse } from '../types';

const SUMMARY: DashboardSummary = {
  totalEntries: 42,
  byType: { fact: 20, decision: 10, methodology: 5, experience: 4, intent: 2, meta: 1 },
  byStatus: { active: 30, pending: 8, deprecated: 3, archived: 1 },
  activeByType: { fact: 15, decision: 6, methodology: 4, experience: 3, intent: 1, meta: 1 },
  graph: { nodes: 42, edges: 64 },
  growth: {
    last7Days: [
      { date: '2026-01-04', count: 1 },
      { date: '2026-01-05', count: 2 },
      { date: '2026-01-06', count: 3 },
      { date: '2026-01-07', count: 4 },
      { date: '2026-01-08', count: 5 },
      { date: '2026-01-09', count: 6 },
      { date: '2026-01-10', count: 7 },
    ],
  },
  confidenceBuckets: { high: 18, medium: 12, low: 9, unknown: 3 },
  health: { pendingCount: 8, unresolvedConflicts: 2 },
  searchHitRate: { current: 0.75, previous: 0.7 },
  nextAction: { title: '处理待复核', description: '有 8 条待复核知识需要处理', href: '/knowledge', tone: 'warning' },
  trends: {
    totalEntries: { percent: 10, direction: 'up', current: 42, previous: 38 },
    pendingCount: { percent: 5, direction: 'down', current: 8, previous: 10 },
    unresolvedConflicts: { percent: 0, direction: 'flat', current: 2, previous: 2 },
    typeCount: { percent: 0, direction: 'flat', current: 6, previous: 6 },
    searchHitRate: { percent: 7, direction: 'up', current: 75, previous: 70 },
  },
};

const KNOWLEDGE = [
  { id: 'k1', content: '最近编辑的知识条目一', status: 'active', type: 'fact', confidence: 0.9, updatedAt: '2026-01-10T10:00:00Z' },
  { id: 'k2', content: '最近编辑的知识条目二', status: 'pending', type: 'decision', updatedAt: '2026-01-09T10:00:00Z' },
];

const RESEARCH = { autoResearchPaused: false, tasks: [] };

vi.mock('@/hooks/use-api', () => ({
  useApi: (url: string) => {
    if (url.includes('dashboard/summary')) return { data: { data: SUMMARY }, isLoading: false, error: undefined, mutate: vi.fn() };
    if (url.includes('knowledge')) return { data: { data: KNOWLEDGE }, isLoading: false, error: undefined, mutate: vi.fn() };
    if (url.includes('conflicts')) return { data: { data: [] }, isLoading: false, error: undefined, mutate: vi.fn() };
    if (url.includes('research')) return { data: { data: RESEARCH }, isLoading: false, error: undefined, mutate: vi.fn() };
    return { data: undefined, isLoading: false, error: undefined, mutate: vi.fn() };
  },
}));

import DashboardPage from '../app/(dashboard)/dashboard/page';

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders recent work timeline', () => {
    render(<DashboardPage />);
    expect(screen.getByText('最近工作')).toBeInTheDocument();
    expect(screen.getByText(/最近编辑的知识条目一/)).toBeInTheDocument();
  });

  it('renders knowledge health section', () => {
    render(<DashboardPage />);
    expect(screen.getAllByText('知识健康度').length).toBeGreaterThan(0);
    expect(screen.getByText('高置信')).toBeInTheDocument();
    expect(screen.getByText('中置信')).toBeInTheDocument();
    expect(screen.getByText('低置信')).toBeInTheDocument();
  });

  it('renders onboarding guide card when not completed', () => {
    render(<DashboardPage />);
    expect(screen.getAllByTestId('onboarding-guide').length).toBeGreaterThan(0);
  });

  it('renders summary stats in header', () => {
    render(<DashboardPage />);
    expect(screen.getAllByText('知识 42 条').length).toBeGreaterThan(0);
    expect(screen.getAllByText('冲突 2 个').length).toBeGreaterThan(0);
  });

  it('renders next action section', () => {
    render(<DashboardPage />);
    expect(screen.getAllByText('有 8 条待复核知识需要处理').length).toBeGreaterThan(0);
    expect(screen.getAllByText('继续处理').length).toBeGreaterThan(0);
  });
});
