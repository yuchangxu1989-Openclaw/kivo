import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DashboardSummary, ApiResponse } from '../types';

const SUMMARY: DashboardSummary = {
  totalEntries: 42,
  weeklyNewEntries: 7,
  wikiSpaceCount: 2,
  wikiSpaces: [
    { id: 's1', title: '概率论', entryCount: 15, updatedAt: '2026-01-10T10:00:00Z' },
    { id: 's2', title: '线性代数', icon: '📐', entryCount: 8, updatedAt: '2026-01-09T10:00:00Z' },
  ],
  byType: { fact: 20, decision: 10, methodology: 5, experience: 4, intent: 2, meta: 1 },
  byStatus: { active: 42 },
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
  trends: {
    totalEntries: { percent: 10, direction: 'up', current: 42, previous: 38 },
    weeklyNewEntries: { percent: 40, direction: 'up', current: 7, previous: 5 },
  },
};

vi.mock('@/hooks/use-api', () => ({
  useApi: (url: string) => {
    if (url.includes('dashboard/summary')) return { data: { data: SUMMARY }, isLoading: false, error: undefined, mutate: vi.fn() };
    return { data: undefined, isLoading: false, error: undefined, mutate: vi.fn() };
  },
}));

vi.mock('@/lib/workbench-store', () => ({
  useWorkbenchStore: (selector: (s: { hasHydrated: boolean }) => boolean) => selector({ hasHydrated: true }),
}));

vi.mock('@/lib/client-api', () => ({
  withBasePath: (p: string) => p,
  BASE_PATH: '',
  apiFetch: vi.fn(),
}));

import DashboardPage from '../app/(dashboard)/dashboard/page';

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders core metrics (FR-W01 AC1)', () => {
    render(<DashboardPage />);
    expect(screen.getByText('知识总量')).toBeInTheDocument();
    expect(screen.getByText('领域知识库')).toBeInTheDocument();
    expect(screen.getByText('本周新增')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('renders wiki space summary cards (FR-W01 AC4)', () => {
    render(<DashboardPage />);
    expect(screen.getByText('概率论')).toBeInTheDocument();
    expect(screen.getByText('线性代数')).toBeInTheDocument();
    expect(screen.getByText('15 条知识')).toBeInTheDocument();
  });

  it('does not show internal metrics like hitRate or health', () => {
    render(<DashboardPage />);
    expect(screen.queryByText(/命中率/)).not.toBeInTheDocument();
    expect(screen.queryByText(/健康度/)).not.toBeInTheDocument();
    expect(screen.queryByText(/冲突/)).not.toBeInTheDocument();
  });
});
