'use client';

import Link from 'next/link';
import { AlertCircle, Inbox, RefreshCw, type LucideIcon } from 'lucide-react';
import { Button, type ButtonProps } from './button';
import { Card, CardContent } from './card';
import { Skeleton } from './skeleton';
import { cn } from './utils';

type ActionConfig = {
  label: string;
  href?: string;
  onClick?: () => void;
  variant?: ButtonProps['variant'];
};

function ActionButton({ action }: { action: ActionConfig }) {
  if (action.href) {
    return (
      <Button variant={action.variant ?? 'default'} asChild>
        <Link href={action.href}>{action.label}</Link>
      </Button>
    );
  }

  return (
    <Button variant={action.variant ?? 'default'} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

export function ErrorState({
  title = '数据加载失败',
  description = '请稍后重试。',
  onRetry,
  retryLabel = '重新加载',
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <Card className={cn('border-destructive/20 bg-background', className)}>
      <CardContent className="flex flex-col items-center gap-4 px-6 py-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertCircle className="h-6 w-6" />
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-slate-950 dark:text-white">{title}</h2>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        {onRetry && (
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {retryLabel}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  primaryAction,
  secondaryAction,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description: string;
  primaryAction?: ActionConfig;
  secondaryAction?: ActionConfig;
  className?: string;
}) {
  return (
    <Card className={cn('border-dashed border-slate-300 bg-white/90 dark:border-slate-600 dark:bg-slate-900/90', className)}>
      <CardContent className="flex flex-col items-center gap-4 px-6 py-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
          <Icon className="h-6 w-6" />
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-slate-950 dark:text-white">{title}</h2>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        {(primaryAction || secondaryAction) && (
          <div className="flex flex-wrap items-center justify-center gap-3">
            {primaryAction && <ActionButton action={primaryAction} />}
            {secondaryAction && <ActionButton action={secondaryAction} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-4 max-w-3xl" />
        <Skeleton className="h-4 w-72" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index} className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardContent className="space-y-4 p-6">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-20" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <Card key={index} className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardContent className="space-y-5 p-6">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-7 w-32" />
              <Skeleton className="h-4 w-64" />
              <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
                <Skeleton className="h-64 rounded-3xl" />
                <div className="space-y-3">
                  {Array.from({ length: 4 }).map((__, rowIndex) => (
                    <Skeleton key={rowIndex} className="h-16 rounded-2xl" />
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function ListPageSkeleton({ filters = 3, rows = 4 }: { filters?: number; rows?: number }) {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-10 w-52" />
        <Skeleton className="h-4 max-w-3xl" />
        <Skeleton className="h-4 w-80" />
      </div>

      <div className="flex flex-wrap gap-3">
        {Array.from({ length: filters }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-36 rounded-xl" />
        ))}
      </div>

      <div className="space-y-4">
        {Array.from({ length: rows }).map((_, index) => (
          <Card key={index} className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardContent className="space-y-4 p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-2">
                  <Skeleton className="h-5 w-52" />
                  <Skeleton className="h-4 w-36" />
                </div>
                <Skeleton className="h-8 w-24 rounded-full" />
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[92%]" />
              <div className="flex gap-2">
                <Skeleton className="h-8 w-20 rounded-full" />
                <Skeleton className="h-8 w-24 rounded-full" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function ResultsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, index) => (
        <Card key={index} className="border-slate-200 bg-white/95 shadow-sm">
          <CardContent className="space-y-3 p-5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <div className="flex gap-2">
              <Skeleton className="h-7 w-16 rounded-full" />
              <Skeleton className="h-7 w-20 rounded-full" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function DetailPageSkeleton() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Skeleton className="h-9 w-20 rounded-full" />
      <Card className="border-slate-200/80 bg-white/95 shadow-sm">
        <CardContent className="space-y-5 p-6 sm:p-8">
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-7 w-20 rounded-full" />
            <Skeleton className="h-7 w-24 rounded-full" />
            <Skeleton className="h-7 w-24 rounded-full" />
          </div>
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </CardContent>
      </Card>
      <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <Card className="border-slate-200/80 bg-white/95 shadow-sm">
          <CardContent className="space-y-4 p-6">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-[96%]" />
            <Skeleton className="h-5 w-[92%]" />
            <Skeleton className="h-5 w-[88%]" />
            <Skeleton className="h-40 w-full rounded-2xl" />
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardContent className="space-y-3 p-6">
              <Skeleton className="h-6 w-28" />
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full rounded-xl" />
              ))}
            </CardContent>
          </Card>
          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardContent className="space-y-3 p-6">
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-16 w-full rounded-2xl" />
              <Skeleton className="h-16 w-full rounded-2xl" />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
