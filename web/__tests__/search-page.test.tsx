import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockUseApi, mockUseApiLoading } from './helpers';

const SEARCH_RESULTS = [
  { id: 's1', type: 'fact', status: 'active', content: '架构评审规则内容', score: 0.92, highlights: ['<mark>架构</mark>评审规则'] },
  { id: 's2', type: 'experience', status: 'active', content: '运维经验总结', score: 0.78 },
];

const mockSearchState: { mode: 'success' | 'loading' | 'empty' } = { mode: 'success' };

vi.mock('@/hooks/use-api', () => ({
  useApi: (url: string | null) => {
    if (!url) return { data: undefined, isLoading: false, error: undefined, mutate: vi.fn() };
    if (mockSearchState.mode === 'loading') return mockUseApiLoading();
    if (mockSearchState.mode === 'empty') return mockUseApi([], { total: 0 });
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
    mockSearchState.mode = 'success';
  });

  it('renders search form and example queries', () => {
    render(<SearchPage />);
    expect(screen.getByText('语义搜索')).toBeInTheDocument();
    expect(getSearchInput()).toBeInTheDocument();
    expect(screen.getAllByText('架构评审规则').length).toBeGreaterThan(0);
  });

  it('submits search and shows results', () => {
    render(<SearchPage />);
    submitSearch('架构');
    expect(screen.getByText('找到 2 条结果')).toBeInTheDocument();
  });

  it('renders advanced time range filter after opening filters', () => {
    render(<SearchPage />);
    fireEvent.click(screen.getByText('高级筛选'));
    expect(screen.getByText('全部时间')).toBeInTheDocument();
    expect(screen.getByText('近 7 天')).toBeInTheDocument();
    expect(screen.getByText('近 30 天')).toBeInTheDocument();
  });

  it('switches time range filter', () => {
    render(<SearchPage />);
    submitSearch('架构');
    fireEvent.click(screen.getByText('高级筛选'));
    const range = screen.getByLabelText('时间范围') as HTMLSelectElement;
    fireEvent.change(range, { target: { value: '7d' } });
    expect(range.value).toBe('7d');
  });

  it('renders loading state after submitting search', () => {
    mockSearchState.mode = 'loading';
    render(<SearchPage />);
    submitSearch('架构');
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders empty state after submitting search with no hits', () => {
    mockSearchState.mode = 'empty';
    render(<SearchPage />);
    submitSearch('不存在的规则');
    expect(screen.getByText('未找到与"不存在的规则"相关的结果')).toBeInTheDocument();
  });

  it('renders action menu trigger on results', () => {
    render(<SearchPage />);
    submitSearch('架构');
    const menuBtns = screen.getAllByLabelText(/操作菜单/);
    expect(menuBtns.length).toBeGreaterThan(0);
  });
});
