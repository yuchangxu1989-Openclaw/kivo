import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ApiResponse } from '../types';

const mutate = vi.fn();
const useApiMock = vi.fn();
const apiFetchMock = vi.fn();

const REGISTRY_RESPONSE: ApiResponse<{
  topics: Array<{
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    taskCount: number;
    reportCount: number;
    referenceReportCount: number;
    wikiEntryCount: number;
    tasks: Array<{
      id: string;
      title: string;
      status: 'running' | 'completed' | 'failed' | 'cancelled';
      createdAt: number;
      updatedAt: number;
      executorId?: string;
      failureReason?: string;
      reports: Array<{
        id: string;
        title: string;
        reportUri: string;
        isReference: boolean;
        wikiEntryCount: number;
        wikiEntries?: Array<{ id: string; title: string; summary?: string }>;
      }>;
    }>;
  }>;
}> = {
  data: {
    topics: [
      {
        id: 'topic-a',
        name: '调研主题 A',
        createdAt: 1790000000000,
        updatedAt: 1790000010000,
        taskCount: 2,
        reportCount: 2,
        referenceReportCount: 1,
        wikiEntryCount: 2,
        tasks: [
          {
            id: 'task-a-running',
            title: '任务 A-1',
            status: 'running',
            createdAt: 1790000000000,
            updatedAt: 1790000010000,
            executorId: 'agent-a',
            reports: [],
          },
          {
            id: 'task-a-done',
            title: '任务 A-2',
            status: 'completed',
            createdAt: 1790000020000,
            updatedAt: 1790000030000,
            reports: [
              {
                id: 'report-reference',
                title: '已确认报告',
                reportUri: 'file:///workspace/reports/reference.md',
                isReference: true,
                wikiEntryCount: 2,
                wikiEntries: [
                  { id: 'entry-1', title: '结论一', summary: '来自报告的结论。' },
                  { id: 'entry-2', title: '结论二' },
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'topic-b',
        name: '调研主题 B',
        createdAt: 1790000040000,
        updatedAt: 1790000050000,
        taskCount: 3,
        reportCount: 2,
        referenceReportCount: 0,
        wikiEntryCount: 0,
        tasks: [
          {
            id: 'task-b-failed',
            title: '任务 B-1',
            status: 'failed',
            createdAt: 1790000040000,
            updatedAt: 1790000050000,
            failureReason: '报告不可访问',
            reports: [],
          },
          {
            id: 'task-b-cancelled',
            title: '任务 B-2',
            status: 'cancelled',
            createdAt: 1790000060000,
            updatedAt: 1790000070000,
            reports: [
              {
                id: 'report-unmarked',
                title: '未确认报告',
                reportUri: 'file:///workspace/reports/unmarked.md',
                isReference: false,
                wikiEntryCount: 0,
              },
            ],
          },
          {
            id: 'task-b-unsafe',
            title: '任务 B-3',
            status: 'completed',
            createdAt: 1790000080000,
            updatedAt: 1790000090000,
            reports: [
              {
                id: 'report-unsafe',
                title: '异常链接报告',
                reportUri: 'javascript:alert(1)',
                isReference: false,
                wikiEntryCount: 0,
              },
            ],
          },
        ],
      },
    ],
  },
};

vi.mock('@/hooks/use-api', () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock('@/lib/client-api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  withBasePath: (path: string) => path,
  BASE_PATH: '',
}));

import ResearchPage from '../app/(dashboard)/research/page';

describe('ResearchPage FR-D03 registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApiMock.mockReturnValue({
      data: REGISTRY_RESPONSE,
      isLoading: false,
      error: undefined,
      mutate,
      isValidating: false,
    });
    apiFetchMock.mockResolvedValue({ data: { isReference: true } });
  });

  it('requests the registry with 3 second refresh and renders grouped topics, statuses, reports, and wiki links', () => {
    render(<ResearchPage />);

    expect(useApiMock).toHaveBeenCalledWith('/api/v1/research', expect.objectContaining({
      refreshInterval: 3000,
      revalidateOnFocus: true,
    }));
    expect(screen.getByText('调研主题 A')).toBeInTheDocument();
    expect(screen.getByText('调研主题 B')).toBeInTheDocument();
    expect(screen.getByText('任务 A-1')).toBeInTheDocument();
    expect(screen.getByText('任务 A-2')).toBeInTheDocument();
    expect(screen.getAllByText('进行中').length).toBeGreaterThan(0);
    expect(screen.getAllByText('已完成').length).toBeGreaterThan(0);
    expect(screen.getAllByText('失败').length).toBeGreaterThan(0);
    expect(screen.getAllByText('已取消').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /已确认报告/ })).toHaveAttribute('href', 'file:///workspace/reports/reference.md');
    expect(screen.getByRole('link', { name: /查看 2 条已入库 Wiki 条目/ })).toHaveAttribute('href', '/knowledge?researchReportId=report-reference');
    expect(screen.getByRole('link', { name: '结论一' })).toHaveAttribute('href', '/knowledge/entry-1');
    expect(screen.queryByText('手动触发调研')).not.toBeInTheDocument();
    expect(screen.queryByText('创建任务')).not.toBeInTheDocument();
    expect(screen.queryByText(/调度器|盲区|缺口分析/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /异常链接报告/ })).not.toBeInTheDocument();
    expect(screen.getByText('报告链接不可打开')).toBeInTheDocument();
  });

  it('shows reference label only for marked reports and calls report reference API for unmarked reports', () => {
    render(<ResearchPage />);

    const markedReport = screen.getByRole('link', { name: /已确认报告/ }).closest('.rounded-xl');
    const unmarkedReport = screen.getByRole('link', { name: /未确认报告/ }).closest('.rounded-xl');
    expect(markedReport).not.toBeNull();
    expect(unmarkedReport).not.toBeNull();
    expect(within(markedReport as HTMLElement).getByText('可参考')).toBeInTheDocument();
    expect(within(unmarkedReport as HTMLElement).queryByText('可参考')).not.toBeInTheDocument();

    fireEvent.click(within(unmarkedReport as HTMLElement).getByRole('button', { name: '标记为可参考' }));

    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/research/reports/report-unmarked/reference', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ confirmedBy: 'kivo-web', forceReextract: false }),
    }));
  });

  it('renders empty state without scheduler or gap panels', () => {
    useApiMock.mockReturnValue({
      data: { data: { topics: [] } },
      isLoading: false,
      error: undefined,
      mutate,
      isValidating: false,
    });

    render(<ResearchPage />);

    expect(screen.getByText('还没有登记的调研报告')).toBeInTheDocument();
    expect(screen.queryByText('手动触发调研')).not.toBeInTheDocument();
    expect(screen.queryByText('创建任务')).not.toBeInTheDocument();
    expect(screen.queryByText(/调度器|盲区|缺口分析/)).not.toBeInTheDocument();
  });
});
