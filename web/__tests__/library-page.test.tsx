import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockMaterials = vi.hoisted(() => [
  {
    id: 'm-needs-review',
    file_name: '低置信度材料.pdf',
    asset_kind: 'pdf',
    status: 'ready',
    classification_status: 'needs_review',
    created_at: '2026-05-24T02:30:00Z',
    subject_node_id: 'subject-1',
  },
]);

const mockSubjects = vi.hoisted(() => [
  {
    id: 'subject-1',
    parent_id: null,
    name: '概率论',
    tree_kind: 'subject',
    origin: 'auto',
    created_at: 1779589800000,
    level: 1,
  },
]);

vi.mock('@/lib/db', () => ({
  openWebDb: () => ({
    prepare: (sql: string) => ({
      all: () => {
        if (sql.includes('FROM materials') && sql.includes('file_name')) return mockMaterials;
        if (sql.includes('FROM subject_nodes')) return mockSubjects;
        if (sql.includes('COUNT(*)')) return [{ id: 'subject-1', count: 1 }];
        return [];
      },
    }),
    close: vi.fn(),
  }),
}));

import LibraryPage from '../app/(dashboard)/library/page';

describe('LibraryPage', () => {
  it('renders needs_review material through shared MaterialCard without collapsing it to classified', () => {
    render(<LibraryPage />);

    expect(screen.getByText('低置信度材料.pdf')).toBeInTheDocument();
    const badge = screen.getByTestId('material-status-badge');
    expect(badge).toHaveTextContent('待确认');
    expect(badge.className).toContain('bg-amber-50');
    expect(screen.queryByText('已分类')).not.toBeInTheDocument();
  });
});
