'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { LinkIcon, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import type { ApiResponse } from '@/types';

interface MentionEntry { id: string; content: string; type: string }

interface UnlinkedMentionsProps {
  entryId: string;
  entryTitle: string;
  onLinked?: () => void;
}

function extractTitle(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  const first = trimmed.split('\n').find((l) => l.trim()) ?? trimmed;
  return first.replace(/^#+\s*/, '').slice(0, 60);
}

function getContext(content: string, title: string): string {
  const idx = content.toLowerCase().indexOf(title.toLowerCase());
  if (idx === -1) return '';
  const start = Math.max(0, idx - 50);
  const end = Math.min(content.length, idx + title.length + 50);
  let s = '';
  if (start > 0) s += '…';
  s += content.substring(start, end);
  if (end < content.length) s += '…';
  return s;
}

export function UnlinkedMentions({ entryId, entryTitle, onLinked }: UnlinkedMentionsProps) {
  const { data, mutate } = useApi<ApiResponse<MentionEntry[]>>('/api/v1/knowledge');
  const allEntries = data?.data ?? [];
  const [linking, setLinking] = useState<string | null>(null);

  const mentions = useMemo(() => {
    if (!entryTitle || entryTitle.length < 3) return [];
    const tLow = entryTitle.toLowerCase();
    const linked = `[[${entryTitle}]]`.toLowerCase();
    return allEntries
      .filter((e) => e.id !== entryId && e.content.toLowerCase().includes(tLow) && !e.content.toLowerCase().includes(linked))
      .map((e) => ({ id: e.id, title: extractTitle(e.content), context: getContext(e.content, entryTitle), content: e.content }));
  }, [allEntries, entryId, entryTitle]);

  async function handleLink(m: { id: string; content: string }) {
    setLinking(m.id);
    try {
      const idx = m.content.toLowerCase().indexOf(entryTitle.toLowerCase());
      if (idx === -1) return;
      const actual = m.content.substring(idx, idx + entryTitle.length);
      const newContent = m.content.substring(0, idx) + `[[${actual}]]` + m.content.substring(idx + entryTitle.length);
      await apiFetch(`/api/v1/knowledge/${m.id}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent, requestId: crypto.randomUUID() }),
      });
      await mutate();
      onLinked?.();
    } finally { setLinking(null); }
  }

  if (mentions.length === 0) return null;

  const displayed = mentions.slice(0, 10);
  const remaining = mentions.length - displayed.length;

  return (
    <Card className="border-slate-200/80 bg-white/95 shadow-sm dark:border-slate-700/60 dark:bg-slate-900/95">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Unlink className="h-4.5 w-4.5 text-muted-foreground" />
          未链接提及
          <span className="text-sm font-normal text-muted-foreground">({mentions.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {displayed.map((m) => (
            <li key={m.id} className="rounded-lg border border-slate-100 p-3 dark:border-slate-800">
              <div className="flex items-center justify-between gap-2">
                <Link href={`/knowledge/${m.id}`} className="text-sm font-medium text-primary hover:underline">{m.title}</Link>
                <Button variant="outline" size="sm" className="shrink-0 gap-1 text-xs" disabled={linking === m.id}
                  onClick={() => void handleLink(m)}>
                  <LinkIcon className="h-3 w-3" />
                  {linking === m.id ? '链接中…' : '一键链接'}
                </Button>
              </div>
              {m.context && <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{m.context}</p>}
            </li>
          ))}
        </ul>
        {remaining > 0 && <p className="mt-2 text-center text-xs text-muted-foreground">还有 {remaining} 条…</p>}
      </CardContent>
    </Card>
  );
}
