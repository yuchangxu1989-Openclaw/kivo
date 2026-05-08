import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { mockUseApi } from './helpers';

const GRAPH_DATA = {
  nodes: [
    { id: 'n1', title: '架构规则', summary: '评审规则', type: 'fact', domain: 'arch', sourceRef: 'adr-001' },
    { id: 'n2', title: '部署策略', summary: '蓝绿部署', type: 'decision', domain: 'ops', sourceRef: 'adr-002' },
  ],
  edges: [
    { source: 'n1', target: 'n2', type: 'supports', weight: 0.8 },
  ],
};

vi.mock('@/hooks/use-api', () => ({
  useApi: () => mockUseApi(GRAPH_DATA),
}));

vi.mock('@/components/knowledge-graph/KnowledgeGraphView', () => ({
  KnowledgeGraphView: (props: Record<string, unknown>) => {
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'graph-view' });
  },
}));

import GraphPage from '../app/(dashboard)/graph/page';

describe('GraphPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders control panel with search, depth slider, and checkboxes', () => {
    render(<GraphPage />);
    expect(screen.getByText('知识图谱')).toBeInTheDocument();
    expect(screen.getAllByLabelText('图谱内搜索').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('邻居深度').length).toBeGreaterThan(0);
    expect(screen.getByText('节点类型')).toBeInTheDocument();
    expect(screen.getByText('关系类型')).toBeInTheDocument();
  });

  it('renders node type filter checkboxes', () => {
    render(<GraphPage />);
    const nodeTypeSection = screen.getByText('节点类型').closest('div')!;
    const labels = ['事实', '决策', '方法论', '经验', '意图', '元知识'];
    for (const label of labels) {
      expect(within(nodeTypeSection).getByText(label)).toBeInTheDocument();
    }
  });

  it('toggles node type checkbox', () => {
    render(<GraphPage />);
    const checkboxes = screen.getAllByRole('checkbox');
    const factCheckbox = checkboxes.find(
      (el) => el.closest('label')?.textContent?.includes('事实')
    ) as HTMLInputElement;
    expect(factCheckbox).toBeDefined();
    fireEvent.click(factCheckbox);
    expect(factCheckbox.checked).toBe(true);
  });

  it('adjusts depth slider', () => {
    render(<GraphPage />);
    const sliders = screen.getAllByLabelText('邻居深度');
    const slider = sliders.find(el => el.tagName === 'INPUT') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '3' } });
    expect(slider.value).toBe('3');
  });

  it('renders graph view component', () => {
    render(<GraphPage />);
    expect(screen.getByTestId('graph-view')).toBeInTheDocument();
  });
});
