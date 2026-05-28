import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { Modal } from '../components/ui/Modal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Loading } from '../components/ui/Loading';
import { Empty } from '../components/ui/Empty';
import { ErrorState } from '../components/ui/ErrorState';

describe('Modal', () => {
  it('renders children when open and closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="编辑学科">
        <p>弹窗内容</p>
      </Modal>,
    );

    expect(screen.getByRole('dialog', { name: '编辑学科' })).toBeInTheDocument();
    expect(screen.getByText('弹窗内容')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="删除确认">
        <p>确认删除？</p>
      </Modal>,
    );

    fireEvent.click(screen.getByLabelText('关闭弹窗'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not render when closed', () => {
    render(
      <Modal open={false} onClose={vi.fn()} title="隐藏弹窗">
        <p>不会出现</p>
      </Modal>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  it('provides onConfirm and onCancel callbacks', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <ConfirmDialog
        open
        title="删除别名"
        onConfirm={onConfirm}
        onCancel={onCancel}
        confirmLabel="删除"
        cancelLabel="保留"
      >
        确认删除这个别名？
      </ConfirmDialog>,
    );

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '保留' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('Loading / Empty / ErrorState', () => {
  it('renders Loading independently with className passthrough', () => {
    render(<Loading label="正在加载学科" className="custom-loading" />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('正在加载学科');
    expect(status).toHaveClass('custom-loading');
  });

  it('renders Empty with icon, text, action and className passthrough', () => {
    render(
      <Empty
        title="没有别名"
        message="先添加一个历史名称。"
        action={<button type="button">添加别名</button>}
        className="custom-empty"
      />,
    );

    expect(screen.getByText('没有别名')).toBeInTheDocument();
    expect(screen.getByText('先添加一个历史名称。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加别名' })).toBeInTheDocument();
    expect(screen.getByText('没有别名').closest('.custom-empty')).toBeTruthy();
  });

  it('renders ErrorState and triggers retry callback', () => {
    const retry = vi.fn();
    render(<ErrorState message="加载失败" retry={retry} className="custom-error" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('加载失败');
    expect(alert).toHaveClass('custom-error');

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
