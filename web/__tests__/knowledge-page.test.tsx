import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockUseApi } from './helpers';

const ENTRIES = [
  { id: '1', type: 'fact', status: 'active', content: '架构评审规则', domain: 'arch', confidence: 0.9, createdAt: '2026-01-01', updatedAt: '2026-01-02', source: { reference: 'adr-001' } },
  { id: '2', type: 'decision', status: 'pending', content: '部署策略决策', domain: 'ops', confidence: 0.7, createdAt: '2026-01-03', updatedAt: '2026-01-04' },
  { id: '3', type: 'methodology', status: 'active', content: '代码审查方法论', confidence: 0.85, createdAt: '2026-01-05', updatedAt: '2026-01-06' },
];

const META = { total: 3, page: 1, pageSize: 24, totalPages: 1 };

vi.mock('@/hooks/use-api', () => ({
  useApi: () => mockUseApi(ENTRIES, META),
}));

import KnowledgeListPage from '../app/(dashboard)/knowledge/page';

function getVisibleByLabel(label: string) {
  return screen.getAllByLabelText(label).find(el => !el.closest('[aria-hidden="true"]'))!;
}

describe('KnowledgeListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders page title and entries', () => {
    render(<KnowledgeListPage />);
    expect(screen.getByText('知识条目')).toBeInTheDocument();
    expect(screen.getByText('架构评审规则')).toBeInTheDocument();
    expect(screen.getByText('部署策略决策')).toBeInTheDocument();
  });

  it('switches between list/table/board views', () => {
    render(<KnowledgeListPage />);
    const buttons = screen.getAllByLabelText('切换到表格视图');
    const tableBtn = buttons.find(el => el.tagName === 'BUTTON' && el.getAttribute('aria-pressed') !== null)!;
    fireEvent.click(tableBtn);
    expect(tableBtn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('table')).toBeInTheDocument();

    const boardBtns = screen.getAllByLabelText('切换到看板视图');
    const boardBtn = boardBtns.find(el => el.tagName === 'BUTTON' && el.getAttribute('aria-pressed') !== null)!;
    fireEvent.click(boardBtn);
    expect(boardBtn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    const listBtns = screen.getAllByLabelText('切换到列表视图');
    const listBtn = listBtns.find(el => el.tagName === 'BUTTON' && el.getAttribute('aria-pressed') !== null)!;
    fireEvent.click(listBtn);
    expect(listBtn).toHaveAttribute('aria-pressed', 'true');
  });

  it('filters entries via quick search', () => {
    render(<KnowledgeListPage />);
    const searchInput = getVisibleByLabel('即时搜索') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: '架构' } });
    expect(screen.getByText('架构评审规则')).toBeInTheDocument();
    expect(screen.queryByText('部署策略决策')).not.toBeInTheDocument();
  });

  it('renders inline edit triggers in table view', () => {
    render(<KnowledgeListPage />);
    const tableBtns = screen.getAllByLabelText('切换到表格视图');
    const tableBtn = tableBtns.find(el => el.tagName === 'BUTTON' && el.getAttribute('aria-pressed') !== null)!;
    fireEvent.click(tableBtn);
    const badges = screen.getAllByText('事实');
    expect(badges.length).toBeGreaterThan(0);
    const clickable = badges.find(el => el.closest('button'));
    if (clickable) {
      fireEvent.click(clickable);
    }
  });
});
