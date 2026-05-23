'use client';

import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Check, CheckCircle2, Clock3, FileText, GitCompareArrows, Loader2, PencilLine, X } from 'lucide-react';

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });
const MarkdownPreview = dynamic(() => import('@uiw/react-md-editor').then(mod => mod.default.Markdown), { ssr: false });
import { EditorWithExtensions } from '@/components/editor/editor-with-extensions';
import { UnlinkedMentions } from '@/components/editor/unlinked-mentions';
import { computeWordDiff, type DiffSegment } from '@/lib/word-diff';
import { useApi } from '@/hooks/use-api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { TagBadge } from '@/components/tag-badge';
import { TagInput } from '@/components/tag-input';
import { RelatedEntries } from '@/components/related-entries';
import { BacklinksPanel } from '@/components/backlinks-panel';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DetailPageSkeleton, ErrorState } from '@/components/ui/page-states';
import type { ApiResponse } from '@/types';
import { apiFetch } from '@/lib/client-api';
import { buildSummary } from '@/lib/text-utils';
import { useCognitiveMode } from '@/contexts/cognitive-mode-context';
import { CognitivePanel } from '@/components/cognitive-panel';
import { SimilarSentenceList } from '@/components/similar-sentences';
import { cn } from '@/components/ui/utils';
import { TYPE_LABELS, typeLabel } from '@/lib/i18n-labels';

interface KnowledgeDetail {
  id: string;
  type: string;
  status: string;
  content: string;
  title?: string;
  domain?: string;
  source?: string;
  sourceLabel?: string;
  sourceDocument?: string;
  sourceLocation?: string;
  metadata?: { tags?: string[]; domainData?: { sourceDocument?: string; sourceLocation?: string } };
  relations?: { type: string; targetId: string; targetContent?: string }[];
  versions?: { version: number; content: string; updatedAt: string; summary?: string }[];
  createdAt: string;
  updatedAt: string;
  version: number;
  similarSentences?: string[] | string | null;
}

const STATUS_LABELS: Record<string, string> = {
  active: '活跃',
};

function DiffText({ segments }: { segments: DiffSegment[] }) {
  return (
    <p className="text-sm leading-relaxed whitespace-pre-wrap">
      {segments.map((seg, i) => (
        <span key={i} className={seg.type === 'removed' ? 'bg-red-100 text-red-800 line-through' : seg.type === 'added' ? 'bg-green-100 text-green-800' : ''}>{seg.text}</span>
      ))}
    </p>
  );
}

function truncateText(text: string, maxLength = 30) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function getRawTitle(content: string, explicitTitle?: string) {
  return explicitTitle?.trim() || content.trim().split('\n').find((line) => line.trim().length > 0)?.trim() || '未命名知识条目';
}

function extractTitle(content: string, explicitTitle?: string) {
  return truncateText(getRawTitle(content, explicitTitle), 30);
}

function VersionHistory({ versions }: { versions: { version: number; content: string; updatedAt: string; summary?: string }[] }) {
  const [diffA, setDiffA] = useState<number | null>(null);
  const [diffB, setDiffB] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diffMode, setDiffMode] = useState<'side-by-side' | 'inline'>('inline');

  const diffResult = useMemo(() => {
    if (diffA == null || diffB == null) return null;
    const vA = versions.find(v => v.version === diffA);
    const vB = versions.find(v => v.version === diffB);
    if (!vA || !vB) return null;
    return computeWordDiff(vA.content, vB.content);
  }, [diffA, diffB, versions]);

  const inlineDiff = useMemo(() => {
    if (diffA == null || diffB == null) return null;
    const vA = versions.find(v => v.version === diffA);
    const vB = versions.find(v => v.version === diffB);
    if (!vA || !vB) return null;
    const linesA = vA.content.split('\n');
    const linesB = vB.content.split('\n');
    const lines: { type: 'same' | 'added' | 'removed'; content: string }[] = [];
    const maxLen = Math.max(linesA.length, linesB.length);
    let ia = 0, ib = 0;
    while (ia < linesA.length || ib < linesB.length) {
      if (ia < linesA.length && ib < linesB.length && linesA[ia] === linesB[ib]) {
        lines.push({ type: 'same', content: linesA[ia] });
        ia++; ib++;
      } else {
        // Simple LCS-like: look ahead for match
        let foundA = -1, foundB = -1;
        for (let look = 1; look <= 5 && look + ia < linesA.length; look++) {
          if (linesA[ia + look] === linesB[ib]) { foundA = look; break; }
        }
        for (let look = 1; look <= 5 && look + ib < linesB.length; look++) {
          if (linesB[ib + look] === linesA[ia]) { foundB = look; break; }
        }
        if (foundA > 0 && (foundB <= 0 || foundA <= foundB)) {
          for (let k = 0; k < foundA; k++) { lines.push({ type: 'removed', content: linesA[ia++] }); }
        } else if (foundB > 0) {
          for (let k = 0; k < foundB; k++) { lines.push({ type: 'added', content: linesB[ib++] }); }
        } else {
          if (ia < linesA.length) lines.push({ type: 'removed', content: linesA[ia++] });
          if (ib < linesB.length) lines.push({ type: 'added', content: linesB[ib++] });
        }
      }
    }
    return lines;
  }, [diffA, diffB, versions]);

  function toggleSelect(ver: number) {
    if (diffA === ver) { setDiffA(null); setShowDiff(false); return; }
    if (diffB === ver) { setDiffB(null); setShowDiff(false); return; }
    if (diffA == null) { setDiffA(ver); return; }
    if (diffB == null) { setDiffB(ver); setShowDiff(true); return; }
    setDiffA(diffB);
    setDiffB(ver);
    setShowDiff(true);
  }

  return (
    <Card className="border-slate-200/80 bg-white/95 shadow-sm">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl">版本历史</CardTitle>
          {diffA != null && diffB != null && (
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
                <button
                  type="button"
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${diffMode === 'inline' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:text-slate-700'}`}
                  onClick={() => setDiffMode('inline')}
                >
                  逐行
                </button>
                <button
                  type="button"
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${diffMode === 'side-by-side' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:text-slate-700'}`}
                  onClick={() => setDiffMode('side-by-side')}
                >
                  并排
                </button>
              </div>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowDiff(!showDiff)}>
                <GitCompareArrows className="h-3.5 w-3.5" />
                {showDiff ? '收起对比' : '查看对比'}
              </Button>
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">点选两个版本进行 diff 对比</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {showDiff && diffA != null && diffB != null && (
          <div className="rounded-2xl border border-indigo-100 bg-indigo-50/30 p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-medium text-indigo-700">
              <GitCompareArrows className="h-4 w-4" />
              v{diffA} → v{diffB} 变更对比
            </div>
            {diffMode === 'side-by-side' && diffResult && (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-red-100 bg-white p-3">
                  <span className="mb-1 block text-[10px] font-medium text-red-600 uppercase">v{diffA}（旧）</span>
                  <DiffText segments={diffResult.left} />
                </div>
                <div className="rounded-xl border border-green-100 bg-white p-3">
                  <span className="mb-1 block text-[10px] font-medium text-green-600 uppercase">v{diffB}（新）</span>
                  <DiffText segments={diffResult.right} />
                </div>
              </div>
            )}
            {diffMode === 'inline' && inlineDiff && (
              <div className="rounded-xl border border-slate-200 bg-white p-3 font-mono text-xs leading-6 overflow-x-auto">
                {inlineDiff.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.type === 'removed'
                        ? 'bg-red-50 text-red-800'
                        : line.type === 'added'
                          ? 'bg-green-50 text-green-800'
                          : 'text-slate-700'
                    }
                  >
                    <span className="inline-block w-5 text-right mr-2 text-slate-400 select-none">
                      {line.type === 'removed' ? '−' : line.type === 'added' ? '+' : ' '}
                    </span>
                    {line.content || '\u00A0'}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {versions.map((version) => {
          const selected = diffA === version.version || diffB === version.version;
          return (
            <div key={version.version} className={`rounded-2xl border p-4 transition-colors cursor-pointer ${selected ? 'border-indigo-300 bg-indigo-50/50' : 'border-slate-100 bg-slate-50/80 hover:border-slate-200'}`} onClick={() => toggleSelect(version.version)} role="button" aria-pressed={selected} aria-label={`选择版本 ${version.version} 进行对比`}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />v{version.version}</span>
                <span>{new Date(version.updatedAt).toLocaleString('zh-CN')}</span>
                {selected && <Badge variant="secondary" className="text-[10px]">已选</Badge>}
              </div>
              <p className="mt-2 text-sm font-medium text-slate-900">{version.summary || buildSummary(version.content)}</p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default function KnowledgeDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;
  const { data, isLoading, error, mutate } = useApi<ApiResponse<KnowledgeDetail>>(`/api/v1/knowledge/${id}`);
  const colorMode = 'light';
  const entry = data?.data;
  const { isFocus } = useCognitiveMode();

  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [editingTags, setEditingTags] = useState(false);
  const [editTags, setEditTags] = useState<string[]>([]);
  const [actionError, setActionError] = useState('');

  const interventionActions = useMemo(() => {
    if (!entry) return [];
    return [] as { label: string; icon: typeof CheckCircle2; tone: 'default' | 'destructive' | 'outline'; run: () => Promise<void> }[];
  }, [entry]);

  if (isLoading) {
    return <DetailPageSkeleton />;
  }

  if (error) {
    return (
      <ErrorState
        title="知识详情加载失败"
        description={error.message || '暂时拿不到这条知识的详情内容。'}
        onRetry={() => void mutate()}
      />
    );
  }

  if (!entry) return <ErrorState title="条目不存在" description="这条知识可能已被删除或尚未同步完成。" onRetry={() => void mutate()} />;

  const rawTitle = getRawTitle(entry.content, entry.title);
  const title = extractTitle(entry.content, entry.title);
  const fullDescription = entry.content.trim() || buildSummary(entry.content);

  async function handleDelete() {
    if (!entry) return;

    setSaving(true);
    setActionMessage('');
    setActionError('');
    try {
      await apiFetch(`/api/v1/knowledge/${id}/status`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: entry.version, requestId: crypto.randomUUID() }),
      });
      setActionMessage('条目已删除。');
      router.push('/knowledge');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '操作失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit() {
    if (!entry) return;

    setSaving(true);
    setActionMessage('');
    setActionError('');
    try {
      await apiFetch(`/api/v1/knowledge/${id}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent, expectedVersion: entry.version, requestId: crypto.randomUUID() }),
      });
      setEditing(false);
      setActionMessage('知识点内容已更新并生成新版本。');
      await mutate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveTitle() {
    if (!entry || !editTitle.trim() || editTitle.trim() === rawTitle) {
      setEditingTitle(false);
      return;
    }
    setSaving(true);
    setActionError('');
    try {
      const newContent = entry.content.trim().startsWith(rawTitle)
        ? editTitle.trim() + entry.content.trim().slice(rawTitle.length)
        : editTitle.trim() + '\n\n' + entry.content;
      await apiFetch(`/api/v1/knowledge/${id}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent, expectedVersion: entry.version, requestId: crypto.randomUUID() }),
      });
      setEditingTitle(false);
      setActionMessage('标题已更新。');
      await mutate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '标题保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveTags(tags: string[]) {
    if (!entry) return;
    setSaving(true);
    setActionError('');
    try {
      await apiFetch(`/api/v1/knowledge/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ metadata: { ...entry.metadata, tags } }),
      });
      setEditingTags(false);
      setActionMessage('标签已更新。');
      await mutate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '标签保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.back()} aria-label="返回上一页">
          ← 返回
        </Button>
      </div>

      <header className="rounded-[28px] border border-slate-200/80 bg-white/95 px-4 py-5 shadow-sm sm:px-6 sm:py-6 md:px-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="bg-violet-100 text-violet-800">{TYPE_LABELS[entry.type] ?? entry.type}</Badge>
              <Badge variant="default">活跃</Badge>
              {entry.domain && <Badge variant="outline">{entry.domain}</Badge>}
            </div>
            {/* Tags */}
            <div className="flex flex-wrap items-center gap-1.5">
              {editingTags ? (
                <div className="w-full space-y-2">
                  <TagInput
                    value={editTags}
                    onChange={setEditTags}
                    suggestions={[]}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={saving} onClick={() => void handleSaveTags(editTags)}>
                      {saving ? '保存中…' : '保存标签'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditingTags(false)}>取消</Button>
                  </div>
                </div>
              ) : (
                <>
                  {(entry.metadata?.tags ?? []).map((tag) => (
                    <TagBadge key={tag} tag={tag} />
                  ))}
                  <button
                    className="inline-flex items-center rounded-full border border-dashed border-slate-300 px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-slate-400 hover:text-slate-700"
                    onClick={() => { setEditTags(entry.metadata?.tags ?? []); setEditingTags(true); }}
                  >
                    + 标签
                  </button>
                </>
              )}
            </div>
            <div className="space-y-3">
              {editingTitle ? (
                <div className="flex items-center gap-2">
                  <input
                    ref={titleInputRef}
                    className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-3xl font-semibold leading-tight tracking-tight text-slate-950 outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveTitle(); if (e.key === 'Escape') setEditingTitle(false); }}
                    onBlur={() => void handleSaveTitle()}
                    aria-label="编辑标题"
                    autoFocus
                  />
                  <Button variant="ghost" size="sm" onClick={() => void handleSaveTitle()} aria-label="确认标题"><Check className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditingTitle(false)} aria-label="取消编辑标题"><X className="h-4 w-4" /></Button>
                </div>
              ) : (
                <h1
                  className="text-3xl font-semibold leading-tight tracking-tight text-slate-950 cursor-pointer hover:text-slate-700 transition-colors"
                  onClick={() => { setEditTitle(rawTitle); setEditingTitle(true); }}
                  title="点击编辑标题"
                >
                  {title}
                </h1>
              )}
              <p className="max-w-3xl whitespace-pre-wrap text-sm leading-7 text-slate-700">{fullDescription}</p>
              {/* Source document tracing (FR-W08) */}
              {(entry.sourceDocument || entry.metadata?.domainData?.sourceDocument) && (
                <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
                  <FileText className="h-4 w-4 text-slate-400 shrink-0" />
                  <div className="text-xs text-slate-600">
                    <span className="font-medium">来源：</span>
                    <span className="ml-1">{entry.sourceDocument || entry.metadata?.domainData?.sourceDocument}</span>
                    {(entry.sourceLocation || entry.metadata?.domainData?.sourceLocation) && (
                      <span className="ml-2 text-slate-400">· {entry.sourceLocation || entry.metadata?.domainData?.sourceLocation}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 lg:justify-end">
            {!editing && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-full border-slate-200 bg-white px-4"
                onClick={() => {
                  setEditContent(entry.content);
                  setEditing(true);
                }}
                aria-label="编辑知识点"
              >
                <PencilLine className="mr-2 h-4 w-4" />
                编辑知识点
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full border-slate-200 bg-slate-50 px-4"
                  aria-label="打开更多知识操作"
                >
                  更多操作
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem disabled={saving} className="text-rose-600 focus:text-rose-600" onClick={() => void handleDelete()}>
                  删除条目
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className={cn('grid gap-6', isFocus ? 'grid-cols-1' : 'grid-cols-1 xl:grid-cols-[1.25fr_0.75fr]')}>
        <Card className="border-slate-200/80 bg-white/95 shadow-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl">内容</CardTitle>
          </CardHeader>
          <CardContent>
            {editing ? (
              <div className="space-y-3">
                <EditorWithExtensions
                  value={editContent}
                  onChange={(val) => setEditContent(val)}
                  height={400}
                  colorMode={colorMode}
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={saving} onClick={handleSaveEdit} aria-label="保存知识内容修改">
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}保存
                  </Button>
                  <Button variant="outline" size="sm" disabled={saving} onClick={() => setEditing(false)} aria-label="取消知识内容编辑">
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <article className="knowledge-detail-body mx-auto max-w-3xl text-slate-800" data-color-mode={colorMode}>
                <MarkdownPreview source={entry.content} style={{ background: 'transparent' }} />
              </article>
            )}
          </CardContent>
        </Card>

        {entry.type === 'intent' && (
          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardHeader className="pb-4">
              <CardTitle className="text-xl">相似表达</CardTitle>
            </CardHeader>
            <CardContent>
              <SimilarSentenceList similarSentences={entry.similarSentences} />
            </CardContent>
          </Card>
        )}

        <CognitivePanel visible={!isFocus}>
        <div className="space-y-6">
          <Card className="border-slate-200/80 bg-white/95 shadow-sm">
            <CardHeader className="pb-4">
              <CardTitle className="text-xl">知识标记与干预</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm leading-6 text-muted-foreground">
                编辑知识点形成新版本，或删除过时的知识条目。
              </p>
              <div className="space-y-2">
                {interventionActions.map((action) => (
                  <Button key={action.label} variant={action.tone} className="w-full justify-start" disabled={saving} onClick={action.run} aria-label={action.label}>
                    {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <action.icon className="mr-2 h-4 w-4" />}
                    {action.label}
                  </Button>
                ))}
                <Button variant="outline" className="w-full justify-start" asChild>
                  <Link href="/activity" aria-label="查看全局活动流">
                    <Clock3 className="mr-2 h-4 w-4" />
                    查看全局活动流
                  </Link>
                </Button>
              </div>
              {actionMessage && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{actionMessage}</p>}
              {actionError && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{actionError}</p>}
            </CardContent>
          </Card>

          <RelatedEntries
            entryId={id}
            relations={entry.relations ?? []}
            onRelationAdded={() => void mutate()}
          />

          <BacklinksPanel entryId={id} />

          <UnlinkedMentions entryId={id} entryTitle={title} onLinked={() => void mutate()} />
        </div>
        </CognitivePanel>
      </div>

      {entry.versions && entry.versions.length > 0 && (
        <VersionHistory versions={entry.versions} />
      )}

      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>创建：{new Date(entry.createdAt).toLocaleString('zh-CN')}</span>
        <span>更新：{new Date(entry.updatedAt).toLocaleString('zh-CN')}</span>
        <span>版本：v{entry.version}</span>
      </div>
    </div>
  );
}
