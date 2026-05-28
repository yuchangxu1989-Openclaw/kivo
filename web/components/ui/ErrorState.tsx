'use client';

import * as React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

import { Button } from './button';
import { cn } from './utils';

export interface ErrorStateProps {
  message: string;
  retry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorState({
  message,
  retry,
  retryLabel = '重试',
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-4 rounded-xl border border-red-200 bg-red-50 p-8 text-center text-red-900',
        className,
      )}
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-100 text-red-600">
        <AlertCircle className="h-6 w-6" />
      </div>
      <p className="max-w-2xl text-sm leading-6">{message}</p>
      {retry && (
        <Button type="button" variant="outline" onClick={retry}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
