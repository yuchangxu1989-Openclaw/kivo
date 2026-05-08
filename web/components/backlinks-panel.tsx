'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUpLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApi } from '@/hooks/use-api';
import type { ApiResponse } from '@/types';

interface BacklinkEntry {
  id: string;
  content: string;
  type: string;
  updatedAt: string;
  relations?: { type: string; targetId: string; targetContent?: string }[];
}

interface BacklinksPanelProps {
  entryId: string;
}

const RELATION_TYPE_LABELS: Record<string, string> = {
  related: '相关',
  references: '引用',
  contradicts: '矛盾',
  supports: '支持',
  depends_on: '依赖',
  co_occurs: '共现',
};

function extractTitle(content: string) {
  const trimmed = content.trim();
  if (!trimmed) return '未命名';
  const first = trimmed.split('\n').find((l) => l.trim()) ?? trimmed;
  return first.length > 50 ? `${first.slice(0, 50)}...` : first;
}

function extractContext(content: string, targetId: string): string {
  const lines = content.split('\n');
  const linkPattern = new RegExp(`\\[\\[.*?${targetId}.*?\\]\\]|${targetId}`, 'i');
  const matchIdx = lines.findIndex((l) => linkPattern.test(l));

  if (matchIdx === -1) {
    const flat = content.replace(/\s+/g, ' ').trim();
    return flat.length > 160 ? `${flat.slice(0, 160)}...` : flat;
  }

  const start = Math.max(0, matchIdx - 1);
  const end = Math.min(lines.length, matchIdx + 2);
  const snippet = lines.slice(start, end).join(' ').replace(/\s+/g, ' ').trim();
  return snippet.length > 160 ? `${snippet.slice(0, 160)}...` : snippet;
}

export function BacklinksPanel({ entryId }: BacklinksPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { data } = useApi<ApiResponse<BacklinkEntry[]>>('/api/v1/knowledge?pageSize=500');
  const allEntries = data?.data ?? [];

  const backlinks = useMemo(
    () =>
      allEntries
        .flatMap((entry) =>
          (entry.relations ?? [])
            .filter((rel) => rel.targetId === entryId)
            .map((rel) => ({
              sourceId: entry.id,
              sourceTitle: extractTitle(entry.content),
              sourceType: entry.type,
              relationType: rel.type,
              context: extractContext(entry.content, entryId),
              updatedAt: entry.updatedAt,
            }))
        )
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [entryId, allEntries]
  );

  return (
    <Card className="border-slate-200/80 bg-white/95 shadow-sm dark:border-slate-700/60 dark:bg-slate-900/95">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="flex items-center gap-2 text-left"
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
            <ArrowUpLeft className="h-4.5 w-4.5 text-muted-foreground" />
            被引用
          </button>
          {backlinks.length > 0 && (
            <Badge variant="secondary" className="ml-1 text-xs">
              {backlinks.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      {!collapsed && (
        <CardContent>
          {backlinks.length === 0 ? (
            <p className="py-3 text-center text-sm text-muted-foreground">暂无其他条目引用此知识</p>
          ) : (
            <ul className="space-y-3">
              {backlinks.map((bl) => (
                <li
                  key={`${bl.sourceId}-${bl.relationType}`}
                  className="rounded-lg border border-slate-100 px-3 py-2.5 transition-colors hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {RELATION_TYPE_LABELS[bl.relationType] ?? bl.relationType}
                    </Badge>
                    <Link
                      href={`/knowledge/${bl.sourceId}`}
                      className="line-clamp-1 flex-1 text-sm font-medium text-primary hover:underline"
                    >
                      {bl.sourceTitle}
                    </Link>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {bl.sourceType}
                    </Badge>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {bl.context}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}
