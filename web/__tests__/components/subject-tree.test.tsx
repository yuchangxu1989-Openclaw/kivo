import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SubjectTree, buildSubjectTree, type SubjectTreeNodeData } from '@/components/subjects/SubjectTree';
import { apiFetch } from '@/lib/client-api';

vi.mock('@/lib/client-api', () => ({
  apiFetch: vi.fn(),
}));

const flatNodes: SubjectTreeNodeData[] = [
  { id: 'math', parent_id: null, name: '数学', materialCount: 2 },
  { id: 'prob', parent_id: 'math', name: '概率论', materialCount: 1 },
  { id: 'clt', parent_id: 'prob', name: '中心极限定理', materialCount: 3 },
];

describe('SubjectTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('builds a hierarchy from parent_id and renders child levels after expansion', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ data: flatNodes });
    render(<SubjectTree storageKey="tree-test" />);

    expect(await screen.findByText('数学')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开 数学' }));
    expect(screen.getByText('概率论')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开 概率论' }));
    expect(screen.getByText('中心极限定理')).toBeInTheDocument();

    expect(buildSubjectTree(flatNodes)[0].children?.[0].children?.[0].id).toBe('clt');
  });

  it('persists expanded state in localStorage', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ data: flatNodes });
    render(<SubjectTree storageKey="persist-test" />);

    expect(await screen.findByText('数学')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开 数学' }));

    await waitFor(() => {
      expect(window.localStorage.getItem('persist-test')).toContain('math');
    });
  });

  it('highlights selected node and triggers callbacks', async () => {
    const onSelect = vi.fn();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    vi.mocked(apiFetch).mockResolvedValueOnce({ data: flatNodes });

    render(
      <SubjectTree
        selectedId="math"
        storageKey="callback-test"
        onSelect={onSelect}
        onRename={onRename}
        onDelete={onDelete}
      />,
    );

    const selected = await screen.findByRole('treeitem', { selected: true });
    expect(selected).toHaveTextContent('数学');

    fireEvent.click(screen.getByRole('button', { name: '数学' }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'math' }));

    fireEvent.click(screen.getByRole('button', { name: '重命名学科域：数学' }));
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: 'math' }));

    fireEvent.click(screen.getByRole('button', { name: '删除学科域：数学' }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'math' }));
  });
});
