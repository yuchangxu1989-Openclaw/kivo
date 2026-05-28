'use client';

import * as React from 'react';
import { Inbox } from 'lucide-react';

import { cn } from './utils';

export interface EmptyProps {
  icon?: React.ComponentType<{ className?: string }> | React.ReactNode;
  title?: string;
  message?: string;
  action?: React.ReactNode;
  className?: string;
}

export function Empty({
  icon = Inbox,
  title = '暂无内容',
  message = '这里还没有可展示的数据。',
  action,
  className,
}: EmptyProps) {
  const renderedIcon = React.isValidElement(icon)
    ? icon
    : React.createElement(icon as React.ComponentType<{ className?: string }>, {
        className: 'h-6 w-6',
      });

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center',
        className,
      )}
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-600">
        {renderedIcon}
      </div>
      <div className="space-y-2">
        <h2 className="text-base font-semibold text-slate-950">{title}</h2>
        <p className="text-sm text-slate-600">{message}</p>
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
