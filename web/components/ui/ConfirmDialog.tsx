'use client';

import * as React from 'react';

import { Button } from './button';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  className?: string;
}

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  children,
  confirmLabel = '确认',
  cancelLabel = '取消',
  destructive = false,
  className,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      className={className}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
