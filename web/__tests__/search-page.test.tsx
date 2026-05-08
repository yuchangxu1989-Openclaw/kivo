import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockUseApi } from './helpers';

const SEARCH_RESULTS = [
  { id: 's1', type: 'fact', status: 'active', content: '架构评审规则内容', score: 0.92, highlights: ['<mark>架构</mark>评审规则'] },
  { id: 's2', type: 'experience', status: 'active', content: '运维经验总结', score: 0.78 },
];

vi.mock('@/hooks/use-api', () => ({
  useApi: (url: string | null) => {
    if (!url) return { data: undefined, isLoading: false, error: undefined, mutate: vi.fn() };
    return mockUseApi(SEARCH_RESULTS, { total: 2 });
  },
}));

import SearchPage from '../app/(dashboard)/search/page';

function getSearchInput() {
  return screen.getAllByLabelText('输入搜索问题').find(el => el.tagName === 'INPUT') as HTMLInputElement;
}

function submitSearch(query: string) {
  const input = getSearchInput();
  fireEvent.change(input, { target: { value: query } });
  fireEvent.submit(input.closest('form')!);
}

describe('SearchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders search form and example queries', () => {
    render(<SearchPage />);
    expect(screen.getByText('语义搜索')).toBeInTheDocument();
    expect(getSearchInput()).toBeInTheDocument();
    expect(screen.getByText('架构评审规则')).toBeInTheDocument();
  });

  it('submits search and shows results', () => {
    render(<SearchPage />);
    submitSearch('架构');
    expect(screen.getByText('找到 2 条结果')).toBeInTheDocument();
  });

  it('renders time range filter buttons', () => {
    render(<SearchPage />);
    expect(screen.getByText('全部时间')).toBeInTheDocument();
    expect(screen.getByText('近 7 天')).toBeInTheDocument();
    expect(screen.getByText('近 30 天')).toBeInTheDocument();
  });

  it('switches time range filter', () => {
    render(<SearchPage />);
    submitSearch('架构');
    const btn7d = screen.getByText('近 7 天');
    fireEvent.click(btn7d);
    expect(btn7d.className).toContain('indigo');
  });

  it('renders action menu trigger on results', () => {
    render(<SearchPage />);
    submitSearch('架构');
    const menuBtns = screen.getAllByLabelText(/操作菜单/);
    expect(menuBtns.length).toBeGreaterThan(0);
  });
});
