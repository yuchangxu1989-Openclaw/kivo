import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockUseApi } from './helpers';

const CONFLICTS = [
  {
    id: 'c1-abcdef01',
    entryA: { id: 'e1', content: '部署使用蓝绿策略', type: 'decision', confidence: 0.8 },
    entryB: { id: 'e2', content: '部署使用金丝雀策略', type: 'decision', confidence: 0.7 },
    status: 'unresolved' as const,
    similarity: 0.85,
    createdAt: '2026-01-10',
    version: 1,
  },
  {
    id: 'c2-resolved1',
    entryA: { id: 'e3', content: '旧规则', type: 'fact' },
    entryB: { id: 'e4', content: '新规则', type: 'fact' },
    status: 'resolved' as const,
    createdAt: '2026-01-05',
    version: 2,
    resolution: { strategy: 'manual', reason: '新规则更准确', resolvedAt: '2026-01-06' },
  },
];

vi.mock('@/hooks/use-api', () => ({
  useApi: () => mockUseApi(CONFLICTS),
}));

import ConflictResolutionPage from '../app/(dashboard)/conflicts/page';

describe('ConflictResolutionPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders conflict cards with entries', () => {
    render(<ConflictResolutionPage />);
    expect(screen.getByText('冲突裁决')).toBeInTheDocument();
    expect(screen.getByText(/c1-abcd/)).toBeInTheDocument();
    expect(screen.getAllByText('条目 A').length).toBeGreaterThan(0);
    expect(screen.getAllByText('条目 B').length).toBeGreaterThan(0);
  });

  it('shows resolution action buttons for unresolved conflict', () => {
    render(<ConflictResolutionPage />);
    expect(screen.getAllByText('保留 A').length).toBeGreaterThan(0);
    expect(screen.getAllByText('保留 B').length).toBeGreaterThan(0);
    expect(screen.getAllByText('合并双方').length).toBeGreaterThan(0);
    expect(screen.getAllByText('同时废弃').length).toBeGreaterThan(0);
  });

  it('shows resolved conflicts section', () => {
    render(<ConflictResolutionPage />);
    expect(screen.getAllByText(/已解决/).length).toBeGreaterThan(0);
    expect(screen.getByText(/c2-reso/)).toBeInTheDocument();
  });

  it('calls resolve API on button click', async () => {
    const { apiFetch } = await import('@/lib/client-api');
    render(<ConflictResolutionPage />);
    const keepABtns = screen.getAllByText('保留 A');
    fireEvent.click(keepABtns[0]);
    expect(apiFetch).toHaveBeenCalled();
  });
});
