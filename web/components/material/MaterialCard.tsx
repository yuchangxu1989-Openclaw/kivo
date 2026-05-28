'use client';

import * as React from 'react';
import { CalendarDays, ExternalLink, FileText, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/components/ui/utils';

export type MaterialCardStatus =
  | 'processing'
  | 'ready'
  | 'pending'
  | 'in_progress'
  | 'classified'
  | 'needs_review'
  | 'failed';

export interface MaterialCardSubject {
  id?: string;
  name: string;
}

export interface MaterialCardMaterial {
  id: string;
  title: string;
  source?: string | null;
  source_url?: string | null;
  subject?: MaterialCardSubject | string | null;
  status: MaterialCardStatus;
  created_at?: string | number | Date | null;
  createdAt?: string | number | Date | null;
}

export interface MaterialCardProps {
  material: MaterialCardMaterial;
  onDetail?: (material: MaterialCardMaterial) => void;
  onDelete?: (material: MaterialCardMaterial) => void;
  className?: string;
}

const STATUS_LABELS: Record<MaterialCardStatus, string> = {
  processing: '处理中',
  ready: '已就绪',
  pending: '待加工',
  in_progress: '分类中',
  classified: '已分类',
  needs_review: '待确认',
  failed: '失败',
};

const STATUS_CLASSES: Record<MaterialCardStatus, string> = {
  processing: 'border-slate-200 bg-slate-100 text-slate-700',
  ready: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  pending: 'border-slate-200 bg-slate-100 text-slate-700',
  in_progress: 'border-blue-200 bg-blue-50 text-blue-700',
  classified: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  needs_review: 'border-amber-200 bg-amber-50 text-amber-800',
  failed: 'border-red-200 bg-red-50 text-red-700',
};

function getSubjectName(subject: MaterialCardMaterial['subject']) {
  if (!subject) return '未归类';
  if (typeof subject === 'string') return subject;
  return subject.name;
}

function getSource(material: MaterialCardMaterial) {
  return material.source ?? material.source_url ?? '来源未记录';
}

function formatCreatedAt(value: MaterialCardMaterial['created_at'] | MaterialCardMaterial['createdAt']) {
  if (!value) return '时间未记录';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function MaterialCard({ material, onDetail, onDelete, className }: MaterialCardProps) {
  const source = getSource(material);
  const createdAt = formatCreatedAt(material.created_at ?? material.createdAt);
  const subjectName = getSubjectName(material.subject);

  return (
    <Card
      className={cn(
        'group border-slate-200/80 bg-white/95 shadow-sm transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-lg',
        className,
      )}
      data-testid="material-card"
    >
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <button
              type="button"
              title={material.title}
              aria-label={`查看物料：${material.title}`}
              onClick={() => onDetail?.(material)}
              className="block max-w-full text-left text-base font-semibold leading-6 text-slate-950 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {material.title}
            </button>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span title={source}>{source}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                <time>{createdAt}</time>
              </span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Badge
              variant="outline"
              className={cn('whitespace-nowrap', STATUS_CLASSES[material.status])}
              data-testid="material-status-badge"
            >
              {STATUS_LABELS[material.status]}
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`查看详情：${material.title}`}
              onClick={() => onDetail?.(material)}
              className="h-8 px-2 text-slate-500 hover:text-slate-950"
            >
              <ExternalLink className="mr-1 h-4 w-4" aria-hidden="true" />
              详情
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`删除物料：${material.title}`}
              onClick={() => onDelete?.(material)}
              className="h-8 px-2 text-red-600 hover:text-red-700"
            >
              <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />
              删除
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="bg-slate-100 text-slate-900">
            {subjectName}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

export function MaterialCardSkeleton({ className }: { className?: string }) {
  return (
    <Card className={cn('border-slate-200/80 bg-white/95 shadow-sm', className)} aria-label="物料卡片加载中">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
          <Skeleton className="h-7 w-16 rounded-full" />
        </div>
        <Skeleton className="h-7 w-24 rounded-full" />
      </CardContent>
    </Card>
  );
}
