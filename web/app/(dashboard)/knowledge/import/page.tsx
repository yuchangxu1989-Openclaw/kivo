'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Upload, FileText, CheckCircle2, XCircle, Pencil, Loader2, Clock,
  ChevronDown, ChevronUp, Check, Filter, FileJson, File,
  CheckSquare, Square, MinusSquare,
} from 'lucide-react';
import { apiFetch } from '@/lib/client-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/page-states';
import type { ImportCandidate } from '@/lib/import-types';
import { TYPE_LABELS, typeLabel } from '@/lib/i18n-labels';

interface ImportJob {
  id: string;
  fileName: string;
  fileType: string;
  fileSizeMb: number;
  processedSegments: number;
  totalSegments: number;
  summary: string;
  createdAt: string;
  candidates: ImportCandidate[];
  stage?: 'uploading' | 'parsing' | 'extracting' | 'ready';
}

const ACCEPTED_EXTENSIONS = ['.md', '.markdown', '.txt', '.text', '.json', '.csv', '.pdf', '.epub'];

function inferFileType(file: File): string | null {
  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (!ext) return null;
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.txt' || ext === '.text') return 'txt';
  if (ext === '.json') return 'json';
  if (ext === '.csv') return 'csv';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.epub') return 'epub';
  return null;
}

const FILE_TYPE_ICON: Record<string, typeof FileText> = {
  md: FileText, txt: File, json: FileJson, csv: File, pdf: FileText, epub: FileText,
};

function parseTextFile(file: File, text: string): ImportCandidate[] {
  const name = file.name.replace(/\.[^.]+$/, '');
  return [{
    id: 'cand-001',
    type: 'fact',
    title: name,
    content: text.trim(),
    sourceAnchor: file.name,
    status: 'pending',
  }];
}

function parseJsonFile(text: string, fileName: string): ImportCandidate[] {
  const data = JSON.parse(text);
  const items: unknown[] = Array.isArray(data) ? data : [data];
  return items
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item, i) => ({
      id: `cand-${String(i + 1).padStart(3, '0')}`,
      type: (typeof item.type === 'string' ? item.type : 'fact'),
      title: (typeof item.title === 'string' ? item.title : `${fileName} #${i + 1}`),
      content: (typeof item.content === 'string' ? item.content : ''),
      domain: typeof item.domain === 'string' ? item.domain : undefined,
      sourceAnchor: `JSON 条目 ${i + 1}`,
      status: 'pending' as const,
    }))
    .filter(c => c.content.trim().length > 0);
}

function splitCsvRow(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { cols.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

function parseCsvFile(text: string, fileName: string): ImportCandidate[] {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvRow(lines[0]).map(h => h.toLowerCase());
  const titleIdx = headers.indexOf('title');
  const contentIdx = headers.indexOf('content');
  const typeIdx = headers.indexOf('type');
  const domainIdx = headers.indexOf('domain');
  if (contentIdx === -1) return [];
  return lines.slice(1)
    .map((line, i) => {
      const cols = splitCsvRow(line);
      return {
        id: `cand-${String(i + 1).padStart(3, '0')}`,
        type: (typeIdx >= 0 && cols[typeIdx]) || 'fact',
        title: (titleIdx >= 0 && cols[titleIdx]) || `${fileName} #${i + 1}`,
        content: cols[contentIdx] ?? '',
        domain: domainIdx >= 0 ? cols[domainIdx] : undefined,
        sourceAnchor: `CSV 行 ${i + 2}`,
        status: 'pending' as const,
      };
    })
    .filter(c => c.content.trim().length > 0);
}

const CANDIDATE_STATUS_LABEL: Record<string, string> = {
  pending: '待确认', confirmed: '已确认', rejected: '已拒绝',
};
const CANDIDATE_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline', confirmed: 'default', rejected: 'destructive',
};

const STAGE_STEPS = [
  { key: 'uploading', label: '上传' },
  { key: 'parsing', label: '解析' },
  { key: 'extracting', label: '提取' },
  { key: 'ready', label: '确认' },
] as const;

function StageIndicator({ stage }: { stage: string }) {
  const idx = STAGE_STEPS.findIndex(s => s.key === stage);
  return (
    <div className="flex items-center gap-1">
      {STAGE_STEPS.map((step, i) => (
        <div key={step.key} className="flex items-center gap-1">
          <div className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium ${
            i < idx ? 'bg-indigo-500 text-white' :
            i === idx ? 'bg-indigo-100 text-indigo-700 ring-2 ring-indigo-500' :
            'bg-slate-100 text-slate-400'
          }`}>{i < idx ? '✓' : i + 1}</div>
          <span className={`text-xs ${i === idx ? 'font-medium text-indigo-700' : 'text-slate-400'}`}>{step.label}</span>
          {i < STAGE_STEPS.length - 1 && <div className={`h-px w-4 ${i < idx ? 'bg-indigo-400' : 'bg-slate-200'}`} />}
        </div>
      ))}
    </div>
  );
}

function UploadZone({ onFiles, uploading }: { onFiles: (files: File[]) => void; uploading: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    if (uploading) return;
    const files = Array.from(e.dataTransfer.files).filter(f => inferFileType(f));
    if (files.length > 0) onFiles(files);
  }, [onFiles, uploading]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter(f => inferFileType(f));
    if (files.length > 0) onFiles(files);
    e.target.value = '';
  }, [onFiles]);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => !uploading && inputRef.current?.click()}
      role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      aria-label="拖拽或点击上传文档"
      className={`flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed p-10 text-center transition-colors
        ${dragOver ? 'border-indigo-400 bg-indigo-50/60' : 'border-slate-300 bg-slate-50/40 hover:border-indigo-300 hover:bg-indigo-50/30'}
        ${uploading ? 'pointer-events-none opacity-60' : ''}`}
    >
      <input ref={inputRef} type="file" multiple accept={ACCEPTED_EXTENSIONS.join(',')} className="hidden" onChange={handleChange} />
      {uploading ? <Loader2 className="h-10 w-10 animate-spin text-indigo-500" /> : <Upload className="h-10 w-10 text-indigo-500" />}
      <div>
        <p className="text-sm font-medium text-slate-800">{uploading ? '正在上传…' : '拖拽文件到此处，或点击选择'}</p>
        <p className="mt-1 text-xs text-muted-foreground">支持 Markdown、纯文本、JSON、CSV、PDF、EPUB，可同时上传多个文件</p>
      </div>
    </div>
  );
}

function CandidateRow({ candidate, onAction, selected, onToggle }: {
  candidate: ImportCandidate; onAction: (action: string, content?: string) => void;
  selected: boolean; onToggle: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(candidate.content);
  const [sourceExpanded, setSourceExpanded] = useState(false);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-start gap-2">
        {candidate.status === 'pending' && (
          <button type="button" onClick={onToggle} className="mt-0.5 shrink-0 text-slate-400 hover:text-indigo-600" aria-label={selected ? '取消选择' : '选择'}>
            {selected ? <CheckSquare className="h-4 w-4 text-indigo-600" /> : <Square className="h-4 w-4" />}
          </button>
        )}
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{TYPE_LABELS[candidate.type] ?? candidate.type}</Badge>
            <Badge variant={CANDIDATE_STATUS_VARIANT[candidate.status] ?? 'outline'}>{CANDIDATE_STATUS_LABEL[candidate.status] ?? candidate.status}</Badge>
          </div>
          <p className="text-sm font-medium text-slate-800">{candidate.title}</p>
          {editing ? (
            <textarea className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400" rows={3} value={editContent} onChange={(e) => setEditContent(e.target.value)} />
          ) : (
            <p className="text-sm text-muted-foreground">{candidate.content.length > 500 ? candidate.content.slice(0, 500) + '…' : candidate.content}</p>
          )}
          <button type="button" className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 hover:underline cursor-pointer bg-transparent border-none p-0" onClick={() => setSourceExpanded(!sourceExpanded)} aria-expanded={sourceExpanded}>
            <FileText className="h-3 w-3" /> {candidate.sourceAnchor}
          </button>
          {sourceExpanded && (
            <div className="mt-1 rounded bg-amber-50/60 border border-amber-200 px-3 py-2 text-xs text-slate-700 whitespace-pre-wrap">
              <span className="block text-[10px] font-medium text-amber-600 mb-1 uppercase tracking-wider">原文上下文</span>
              {candidate.sourceContext || candidate.content}
            </div>
          )}
        </div>
      </div>
      {candidate.status === 'pending' && (
        <div className="flex gap-2">
          {editing ? (
            <>
              <Button size="sm" variant="default" disabled={!editContent.trim()} onClick={() => { onAction('edit', editContent); setEditing(false); }}><Check className="mr-1 h-3 w-3" />保存并确认</Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>取消</Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="default" onClick={() => onAction('confirm')}><CheckCircle2 className="mr-1 h-3 w-3" />确认</Button>
              <Button size="sm" variant="outline" onClick={() => { setEditContent(candidate.content); setEditing(true); }}><Pencil className="mr-1 h-3 w-3" />修改</Button>
              <Button size="sm" variant="outline" onClick={() => onAction('reject')}><XCircle className="mr-1 h-3 w-3" />拒绝</Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function JobCard({ job, onUpdateJob, onImport, importing }: {
  job: ImportJob; onUpdateJob: (job: ImportJob) => void;
  onImport: (job: ImportJob) => void; importing: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const pendingCandidates = job.candidates.filter(c => c.status === 'pending');
  const confirmedCandidates = job.candidates.filter(c => c.status === 'confirmed');
  const candidateTypes = [...new Set(job.candidates.map(c => c.type))];
  const filtered = typeFilter ? job.candidates.filter(c => c.type === typeFilter) : job.candidates;
  const grouped = useMemo(() => {
    const map = new Map<string, ImportCandidate[]>();
    for (const c of filtered) { const arr = map.get(c.type) || []; arr.push(c); map.set(c.type, arr); }
    return map;
  }, [filtered]);

  const filteredPending = filtered.filter(c => c.status === 'pending');
  const allSelected = filteredPending.length > 0 && filteredPending.every(c => selectedIds.has(c.id));
  const someSelected = filteredPending.some(c => selectedIds.has(c.id));

  function toggleAll() {
    if (allSelected) { setSelectedIds(new Set()); }
    else { setSelectedIds(new Set(filteredPending.map(c => c.id))); }
  }
  function toggleOne(id: string) {
    setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  function updateCandidate(candidateId: string, action: string, content?: string) {
    const updated = { ...job, candidates: job.candidates.map(c => {
      if (c.id !== candidateId) return c;
      if (action === 'confirm') return { ...c, status: 'confirmed' as const };
      if (action === 'reject') return { ...c, status: 'rejected' as const };
      if (action === 'edit' && content) return { ...c, content, status: 'confirmed' as const };
      return c;
    })};
    onUpdateJob(updated);
  }

  function bulkAction(action: string) {
    const ids = selectedIds.size > 0 ? selectedIds : new Set(filteredPending.map(c => c.id));
    const updated = { ...job, candidates: job.candidates.map(c => {
      if (!ids.has(c.id) || c.status !== 'pending') return c;
      if (action === 'confirm') return { ...c, status: 'confirmed' as const };
      if (action === 'reject') return { ...c, status: 'rejected' as const };
      return c;
    })};
    setSelectedIds(new Set());
    onUpdateJob(updated);
  }

  const stage = job.stage || 'ready';
  const FileIcon = FILE_TYPE_ICON[job.fileType] ?? FileText;

  return (
    <Card className="border-slate-200/80 bg-white/95 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FileIcon className="h-5 w-5 text-indigo-500" />
            <div>
              <CardTitle className="text-base">{job.fileName}</CardTitle>
              <p className="text-xs text-muted-foreground">{job.fileType.toUpperCase()} · {job.fileSizeMb.toFixed(1)} MB · {job.createdAt}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {stage !== 'ready' ? <StageIndicator stage={stage} /> : <Badge variant="default">提取完成</Badge>}
            <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)} aria-label={expanded ? '收起' : '展开'}>
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        {stage === 'extracting' && job.totalSegments > 0 && (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${Math.round((job.processedSegments / job.totalSegments) * 100)}%` }} />
          </div>
        )}
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-3 pt-0">
          <p className="text-sm text-muted-foreground">{job.summary}</p>
          {pendingCandidates.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-2">
              <button type="button" onClick={toggleAll} className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-indigo-600">
                {allSelected ? <CheckSquare className="h-3.5 w-3.5 text-indigo-600" /> : someSelected ? <MinusSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                {allSelected ? '取消全选' : '全选'}
              </button>
              <span className="text-xs text-slate-300">|</span>
              {candidateTypes.map(t => (
                <button key={t} type="button" onClick={() => setTypeFilter(typeFilter === t ? null : t)}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors ${typeFilter === t ? 'bg-indigo-100 text-indigo-700' : 'bg-white text-slate-600 hover:bg-slate-100'}`}>
                  <Filter className="h-3 w-3" />{TYPE_LABELS[t] ?? t}
                </button>
              ))}
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="default" disabled={selectedIds.size === 0} onClick={() => bulkAction('confirm')}>
                  <Check className="mr-1 h-3 w-3" />
                  确认选中 ({selectedIds.size})
                </Button>
                <Button size="sm" variant="outline" disabled={selectedIds.size === 0} onClick={() => bulkAction('reject')}>
                  <XCircle className="mr-1 h-3 w-3" />拒绝选中
                </Button>
              </div>
            </div>
          )}
          {[...grouped.entries()].map(([type, candidates]) => (
            <div key={type} className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{TYPE_LABELS[type] ?? type}</Badge>
                <span className="text-xs text-muted-foreground">{candidates.length} 条</span>
              </div>
              {candidates.map(candidate => (
                <CandidateRow key={candidate.id} candidate={candidate}
                  onAction={(action, content) => updateCandidate(candidate.id, action, content)}
                  selected={selectedIds.has(candidate.id)} onToggle={() => toggleOne(candidate.id)} />
              ))}
            </div>
          ))}
          {confirmedCandidates.length > 0 && pendingCandidates.length === 0 && (
            <div className="flex items-center justify-between rounded-lg bg-indigo-50 p-3">
              <span className="text-sm text-indigo-700">{confirmedCandidates.length} 条已确认，准备导入知识库</span>
              <Button size="sm" variant="default" disabled={importing} onClick={() => onImport(job)}>
                {importing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
                导入知识库
              </Button>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default function DocumentImportPage() {
  const [uploading, setUploading] = useState(false);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ success: number; failed: number } | null>(null);
  const [parseErrors, setParseErrors] = useState<string[]>([]);

  const handleFiles = useCallback(async (files: File[]) => {
    setUploading(true);
    setImportResult(null);
    setParseErrors([]);
    try {
      const newJobs: ImportJob[] = [];
      const errors: string[] = [];
      for (const file of files) {
        const fileType = inferFileType(file);
        if (!fileType) continue;
        let candidates: ImportCandidate[] = [];
        try {
          if (fileType === 'pdf') {
            const { parsePdfFile } = await import('@/lib/document-parsers');
            candidates = await parsePdfFile(file);
          } else if (fileType === 'epub') {
            const { parseEpubFile } = await import('@/lib/document-parsers');
            candidates = await parseEpubFile(file);
          } else {
            const text = await file.text();
            if (fileType === 'json') candidates = parseJsonFile(text, file.name);
            else if (fileType === 'csv') candidates = parseCsvFile(text, file.name);
            else candidates = parseTextFile(file, text);
          }
        } catch {
          if (fileType === 'pdf') errors.push(`${file.name}：PDF 解析失败，请确认文件未加密`);
          else if (fileType === 'epub') errors.push(`${file.name}：EPUB 解析失败，请确认文件格式正确`);
          else errors.push(`${file.name}：文件解析失败`);
          continue;
        }
        if (candidates.length === 0) {
          if (fileType === 'pdf' || fileType === 'epub') errors.push(`${file.name}：未能提取到文本内容`);
          continue;
        }
        newJobs.push({
          id: `imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          fileName: file.name,
          fileType,
          fileSizeMb: Math.round((file.size / 1024 / 1024) * 100) / 100 || 0.01,
          processedSegments: candidates.length,
          totalSegments: candidates.length,
          summary: `已解析 ${candidates.length} 条知识条目`,
          createdAt: new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date()),
          candidates,
          stage: 'ready',
        });
      }
      if (newJobs.length > 0) setJobs(prev => [...newJobs, ...prev]);
      if (errors.length > 0) setParseErrors(errors);
    } finally { setUploading(false); }
  }, []);

  const updateJob = useCallback((updated: ImportJob) => {
    setJobs(prev => prev.map(j => j.id === updated.id ? updated : j));
  }, []);

  const handleImport = useCallback(async (job: ImportJob) => {
    const confirmed = job.candidates.filter(c => c.status === 'confirmed');
    if (confirmed.length === 0) return;
    setImporting(true);
    setImportResult(null);
    let success = 0;
    let failed = 0;
    for (const c of confirmed) {
      try {
        await apiFetch('/api/v1/knowledge', {
          method: 'POST',
          body: JSON.stringify({
            title: c.title,
            content: c.content,
            type: c.type || 'fact',
            domain: c.domain,
            status: 'active',
          }),
        });
        success++;
      } catch { failed++; }
    }
    setImportResult({ success, failed });
    if (success > 0) {
      setJobs(prev => prev.filter(j => j.id !== job.id));
    }
    setImporting(false);
  }, []);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">文档导入</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          上传文档后系统自动提取知识候选条目。支持 Markdown、纯文本、JSON、CSV、PDF 和 EPUB 格式。你可以按类型筛选、批量确认或逐条审核。
        </p>
      </div>
      {importResult && (
        <div className={`flex items-center gap-2 rounded-lg p-3 text-sm ${importResult.failed > 0 ? 'bg-amber-50 text-amber-800' : 'bg-green-50 text-green-800'}`}>
          <CheckCircle2 className="h-4 w-4" />
          导入完成：成功 {importResult.success} 条{importResult.failed > 0 ? `，失败 ${importResult.failed} 条` : ''}
        </div>
      )}
      {parseErrors.length > 0 && (
        <div className="space-y-1 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-300">
          {parseErrors.map((err, i) => <p key={i}>{err}</p>)}
        </div>
      )}
      <Card className="border-slate-200/80 bg-white/95 shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2 text-indigo-600">
            <Upload className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-[0.2em]">上传文档</span>
          </div>
          <CardTitle className="text-xl">拖拽或选择文件开始导入</CardTitle>
        </CardHeader>
        <CardContent><UploadZone onFiles={handleFiles} uploading={uploading} /></CardContent>
      </Card>
      {jobs.length === 0 ? (
        <EmptyState icon={FileText} title="暂无导入记录" description="上传文档后，提取的知识候选条目会显示在这里。" />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-indigo-600">
            <Clock className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-[0.2em]">导入历史</span>
          </div>
          {jobs.map(job => <JobCard key={job.id} job={job} onUpdateJob={updateJob} onImport={handleImport} importing={importing} />)}
        </div>
      )}
    </div>
  );
}