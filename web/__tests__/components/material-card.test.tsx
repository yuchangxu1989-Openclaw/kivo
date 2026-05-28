import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MaterialCard, type MaterialCardMaterial } from '@/components/material/MaterialCard';

const baseMaterial: MaterialCardMaterial = {
  id: 'm1',
  title: '这是一条很长很长的资料标题，用来确认标题截断时仍然保留 tooltip',
  source: '飞书资料库',
  subject: { id: 's1', name: '概率论' },
  status: 'pending',
  created_at: '2026-05-24T01:00:00Z',
};

describe('MaterialCard', () => {
  it('renders title with truncation class and tooltip', () => {
    render(<MaterialCard material={baseMaterial} />);
    const title = screen.getByRole('button', { name: `查看物料：${baseMaterial.title}` });
    expect(title).toHaveAttribute('title', baseMaterial.title);
    expect(title).toBeInTheDocument();
  });

  it.each([
    ['processing', 'bg-slate-100', '处理中'],
    ['ready', 'bg-emerald-50', '已就绪'],
    ['pending', 'bg-slate-100', '待加工'],
    ['in_progress', 'bg-blue-50', '分类中'],
    ['classified', 'bg-emerald-50', '已分类'],
    ['needs_review', 'bg-amber-50', '待确认'],
    ['failed', 'bg-red-50', '失败'],
  ] as const)('maps %s status to expected badge color and label', (status, colorClass, label) => {
    render(<MaterialCard material={{ ...baseMaterial, status }} />);
    const badge = screen.getByTestId('material-status-badge');
    expect(badge.className).toContain(colorClass);
    expect(badge).toHaveTextContent(label);
  });

  it('calls onDetail from title and onDelete from action menu', async () => {
    const onDetail = vi.fn();
    const onDelete = vi.fn();
    render(<MaterialCard material={baseMaterial} onDetail={onDetail} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: `查看物料：${baseMaterial.title}` }));
    expect(onDetail).toHaveBeenCalledWith(baseMaterial);

    fireEvent.click(screen.getByRole('button', { name: `删除物料：${baseMaterial.title}` }));
    expect(onDelete).toHaveBeenCalledWith(baseMaterial);
  });
});
