'use client';

import * as React from 'react';

import { cn } from './utils';

export interface LoadingProps {
  label?: string;
  className?: string;
}

export function Loading({ label = '加载中…', className }: LoadingProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex items-center justify-center gap-3 rounded-xl p-6 text-sm text-slate-600', className)}
    >
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900" />
      <span>{label}</span>
    </div>
  );
}
