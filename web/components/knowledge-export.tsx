'use client';

import { useState } from 'react';
import { Download, FileJson, FileText, Loader2 } from 'lucide-react';
import type JSZipType from 'jszip';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiFetch } from '@/lib/client-api';
import type { ApiResponse } from '@/types';

interface KnowledgeEntry {
  id: string;
  type: string;
  status: string;
  content: string;
  domain?: string;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
  source?: { reference?: string };
  metadata?: { tags?: string[] };
}

type ExportScope = 'all' | 'filtered' | 'selected';
type ExportFormat = 'markdown' | 'json';

interface KnowledgeExportProps {
  /** Currently filtered entries (from the page's current filter state) */
  filteredEntries: KnowledgeEntry[];
  /** Currently selected entry IDs */
  selectedIds: Set<string>;
  /** Current filter params to fetch all matching results */
  filterParams?: string;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function entryToMarkdown(entry: KnowledgeEntry): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`id: ${entry.id}`);
  lines.push(`type: ${entry.type}`);
  lines.push(`status: ${entry.status}`);
  if (entry.domain) lines.push(`domain: ${entry.domain}`);
  if (entry.confidence != null) lines.push(`confidence: ${entry.confidence}`);
  lines.push(`createdAt: ${entry.createdAt}`);
  lines.push(`updatedAt: ${entry.updatedAt}`);
  if (entry.source?.reference) lines.push(`source: ${entry.source.reference}`);
  if (entry.metadata?.tags?.length) lines.push(`tags: [${entry.metadata.tags.join(', ')}]`);
  lines.push('---');
  lines.push('');
  lines.push(entry.content);
  lines.push('');
  return lines.join('\n');
}

function sanitizeFilename(content: string, id: string): string {
  const firstLine = content.trim().split('\n')[0] || '';
  const cleaned = firstLine
    .replace(/[#*`]/g, '')
    .trim()
    .slice(0, 40)
    .replace(/[/\\:*?"<>|]/g, '_')
    .trim();
  return cleaned || id.slice(0, 8);
}

export function KnowledgeExport({ filteredEntries, selectedIds, filterParams }: KnowledgeExportProps) {
  const [exporting, setExporting] = useState(false);

  async function fetchAllEntries(): Promise<KnowledgeEntry[]> {
    // Fetch all pages
    const allEntries: KnowledgeEntry[] = [];
    let page = 1;
    const pageSize = 100;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams(filterParams || '');
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));

      const res = await apiFetch<ApiResponse<KnowledgeEntry[]>>(
        `/api/v1/knowledge?${params.toString()}`,
      );
      const items = res.data ?? [];
      allEntries.push(...items);

      if (items.length < pageSize) {
        hasMore = false;
      } else {
        page++;
      }
    }

    return allEntries;
  }

  function getEntriesForScope(scope: ExportScope, allEntries?: KnowledgeEntry[]): KnowledgeEntry[] {
    switch (scope) {
      case 'selected':
        return filteredEntries.filter((e) => selectedIds.has(e.id));
      case 'filtered':
        return filteredEntries;
      case 'all':
        return allEntries ?? filteredEntries;
    }
  }

  async function handleExport(format: ExportFormat, scope: ExportScope) {
    setExporting(true);
    try {
      let entries: KnowledgeEntry[];

      if (scope === 'all') {
        entries = await fetchAllEntries();
      } else {
        entries = getEntriesForScope(scope);
      }

      if (entries.length === 0) {
        toast.error('没有可导出的条目');
        return;
      }

      const timestamp = new Date().toISOString().slice(0, 10);

      if (format === 'json') {
        const jsonContent = JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            count: entries.length,
            entries,
          },
          null,
          2,
        );
        const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8' });
        const { saveAs } = await import('file-saver');
        saveAs(blob, `kivo-knowledge-${timestamp}.json`);
        toast.success(`已导出 ${entries.length} 条知识（JSON）`);
      } else {
        const { default: JSZip } = await import('jszip');
        const { saveAs } = await import('file-saver');
        const zip: JSZipType = new JSZip();
        const folder = zip.folder('kivo-knowledge');

        if (folder) {
          for (const entry of entries) {
            const filename = `${sanitizeFilename(entry.content, entry.id)}-${entry.id.slice(0, 6)}.md`;
            folder.file(filename, entryToMarkdown(entry));
          }
        }

        const blob = await zip.generateAsync({ type: 'blob' });
        saveAs(blob, `kivo-knowledge-${timestamp}.zip`);
        toast.success(`已导出 ${entries.length} 条知识（Markdown ZIP）`);
      }
    } catch (err) {
      toast.error(`导出失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setExporting(false);
    }
  }

  const hasSelected = selectedIds.size > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={exporting}>
          {exporting ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="mr-1.5 h-3.5 w-3.5" />
          )}
          导出
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Markdown（ZIP 打包）
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => void handleExport('markdown', 'all')} className="gap-2 cursor-pointer">
          <FileText className="h-3.5 w-3.5" />
          导出全部
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void handleExport('markdown', 'filtered')} className="gap-2 cursor-pointer">
          <FileText className="h-3.5 w-3.5" />
          导出当前筛选（{filteredEntries.length} 条）
        </DropdownMenuItem>
        {hasSelected && (
          <DropdownMenuItem onClick={() => void handleExport('markdown', 'selected')} className="gap-2 cursor-pointer">
            <FileText className="h-3.5 w-3.5" />
            导出选中（{selectedIds.size} 条）
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-xs text-muted-foreground">
          JSON（完整数据含 metadata）
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => void handleExport('json', 'all')} className="gap-2 cursor-pointer">
          <FileJson className="h-3.5 w-3.5" />
          导出全部
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void handleExport('json', 'filtered')} className="gap-2 cursor-pointer">
          <FileJson className="h-3.5 w-3.5" />
          导出当前筛选（{filteredEntries.length} 条）
        </DropdownMenuItem>
        {hasSelected && (
          <DropdownMenuItem onClick={() => void handleExport('json', 'selected')} className="gap-2 cursor-pointer">
            <FileJson className="h-3.5 w-3.5" />
            导出选中（{selectedIds.size} 条）
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
