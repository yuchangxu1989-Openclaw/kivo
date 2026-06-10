import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/client-api';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  mutate: vi.fn(),
  items: [
    {
      id: 'intent-1',
      name: '用户表达了一个非常长的意图名称：希望系统记住后续处理原因',
      description: '需要在列表中显示可扫读的描述摘要，避免只看到半截内容。',
      why: '这条 why 说明该意图为什么存在，列表默认要有缩略信息，hover 时要看到完整内容。',
      similarSentences: ['记住这个处理原因'],
      relatedEntryCount: 0,
      recentHitCount: 0,
      recentSnippets: [],
      updateStatus: 'synced',
      createdAt: '2026-06-08T10:00:00.000Z',
      updatedAt: '2026-06-09T10:00:00.000Z',
    },
    {
      id: 'intent-1',
      name: '用户表达了一个非常长的意图名称：希望系统记住后续处理原因',
      description: '需要在列表中显示可扫读的描述摘要，避免只看到半截内容。',
      why: '这条 why 说明该意图为什么存在，列表默认要有缩略信息，hover 时要看到完整内容。',
      similarSentences: ['重复记录'],
      relatedEntryCount: 0,
      recentHitCount: 0,
      recentSnippets: [],
      updateStatus: 'idle',
      createdAt: '2026-06-08T09:00:00.000Z',
      updatedAt: '2026-06-09T09:00:00.000Z',
    },
    {
      id: 'intent-2',
      name: '删除目标',
      description: '用于验证删除后立即从列表移除。',
      why: '删除必须真实调用 API。',
      similarSentences: [],
      relatedEntryCount: 0,
      recentHitCount: 0,
      recentSnippets: [],
      updateStatus: 'synced',
      createdAt: '2026-06-07T10:00:00.000Z',
      updatedAt: '2026-06-08T10:00:00.000Z',
    },
  ],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mocks.push,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

vi.mock('@/hooks/use-api', () => ({
  useApi: () => ({
    data: { data: { items: mocks.items } },
    isLoading: false,
    error: undefined,
    mutate: mocks.mutate,
    isValidating: false,
  }),
}));

import IntentPage from '../app/(dashboard)/intent/page';

describe('IntentPage FR-W15 UX', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiFetch).mockResolvedValue({});
    mocks.mutate.mockResolvedValue(undefined);
  });

  it('renders a deduped vertical list with summaries and no persistent create form table', () => {
    render(<IntentPage />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建意图' })).toBeInTheDocument();
    expect(screen.queryByLabelText('名称')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(2);

    const title = screen.getByText('希望系统记住后续处理原因');
    expect(title).toHaveAttribute('title', '用户表达了一个非常长的意图名称：希望系统记住后续处理原因');
    expect(screen.getByText('需要在列表中显示可扫读的描述摘要')).toHaveAttribute('title', '需要在列表中显示可扫读的描述摘要，避免只看到半截内容。');
    expect(screen.getByText('这条 why 说明该意图为什么存在')).toHaveAttribute('title', '这条 why 说明该意图为什么存在，列表默认要有缩略信息，hover 时要看到完整内容。');
  });

  it('opens create dialog and submits name, description, why and similar sentences', async () => {
    render(<IntentPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建意图' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新意图' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '新描述' } });
    fireEvent.change(screen.getByLabelText('why'), { target: { value: '新 why' } });
    fireEvent.change(screen.getByLabelText('相似句'), { target: { value: '第一句\n第二句' } });
    fireEvent.click(screen.getByRole('button', { name: '保存意图' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/v1/intent/create', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: '新意图',
          description: '新描述',
          why: '新 why',
          similarSentences: ['第一句', '第二句'],
        }),
      }));
    });
  });

  it('deletes through the backend API and removes the item from the visible list', async () => {
    render(<IntentPage />);

    fireEvent.click(screen.getByRole('button', { name: '删除 删除目标' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/v1/intent?id=intent-2', { method: 'DELETE' });
    });
    await waitFor(() => {
      expect(screen.queryByText('删除目标')).not.toBeInTheDocument();
    });
  });

  it('navigates to the clicked intent detail', () => {
    render(<IntentPage />);

    fireEvent.click(screen.getByRole('link', { name: '打开意图 希望系统记住后续处理原因' }));

    expect(mocks.push).toHaveBeenCalledWith('/intent/intent-1');
  });
});
