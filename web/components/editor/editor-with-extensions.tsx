'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useApi } from '@/hooks/use-api';
import type { ApiResponse } from '@/types';

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });

interface EditorEntry {
  id: string;
  title: string;
  content: string;
}

interface EditorWithExtensionsProps {
  value: string;
  onChange: (val: string) => void;
  height?: number;
  colorMode?: string;
}

function extractTitle(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  const first = trimmed.split('\n').find((l) => l.trim()) ?? trimmed;
  return first.replace(/^#+\s*/, '').slice(0, 60);
}

function getCursorCoords(textarea: HTMLTextAreaElement, position: number): { top: number; left: number } {
  const mirror = document.createElement('div');
  const style = getComputedStyle(textarea);
  for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'border', 'boxSizing']) {
    mirror.style.setProperty(prop, style.getPropertyValue(prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())));
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  const textNode = document.createTextNode(textarea.value.substring(0, position));
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(textNode);
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const mRect = marker.getBoundingClientRect();
  const dRect = mirror.getBoundingClientRect();
  document.body.removeChild(mirror);
  return { top: mRect.top - dRect.top - textarea.scrollTop, left: mRect.left - dRect.left - textarea.scrollLeft };
}

const SLASH_COMMANDS = [
  { label: '标题 1', syntax: '# ', icon: 'H1' },
  { label: '标题 2', syntax: '## ', icon: 'H2' },
  { label: '标题 3', syntax: '### ', icon: 'H3' },
  { label: '代码块', syntax: '```\n\n```', icon: '<>' },
  { label: '引用', syntax: '> ', icon: '❝' },
  { label: '分割线', syntax: '---\n', icon: '—' },
  { label: '双链 [[', syntax: '[[', icon: '🔗', triggerWikiLink: true },
  { label: '无序列表', syntax: '- ', icon: '•' },
  { label: '有序列表', syntax: '1. ', icon: '#' },
  { label: '表格', syntax: '| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| | | |', icon: '⊞' },
] as const;

type SlashCmd = (typeof SLASH_COMMANDS)[number];

export function EditorWithExtensions({ value, onChange, height = 400, colorMode }: EditorWithExtensionsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [wikiOpen, setWikiOpen] = useState(false);
  const [wikiQuery, setWikiQuery] = useState('');
  const [wikiPos, setWikiPos] = useState({ top: 0, left: 0 });
  const [wikiTrigger, setWikiTrigger] = useState(-1);
  const [wikiIdx, setWikiIdx] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashPos, setSlashPos] = useState({ top: 0, left: 0 });
  const [slashTrigger, setSlashTrigger] = useState(-1);
  const [slashIdx, setSlashIdx] = useState(0);
  const keydownRef = useRef<(e: KeyboardEvent) => void>(() => {});

  const { data } = useApi<ApiResponse<EditorEntry[]>>(wikiOpen ? '/api/v1/knowledge' : null);
  const allEntries = data?.data ?? [];

  const filteredEntries = useMemo(() => {
    const q = wikiQuery.toLowerCase();
    const list = q ? allEntries.filter((e) => (e.title || extractTitle(e.content)).toLowerCase().includes(q)) : allEntries;
    return list.slice(0, 10);
  }, [allEntries, wikiQuery]);

  const filteredCmds = useMemo(() => {
    if (!slashQuery) return [...SLASH_COMMANDS];
    const q = slashQuery.toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.label.toLowerCase().includes(q));
  }, [slashQuery]);

  const getTA = useCallback((): HTMLTextAreaElement | null => {
    return containerRef.current?.querySelector('.w-md-editor-text-input') ?? null;
  }, []);

  const insertAt = useCallback((text: string, triggerPos: number) => {
    const ta = getTA();
    if (!ta) return;
    const cursor = ta.selectionStart;
    const newVal = value.substring(0, triggerPos) + text + value.substring(cursor);
    onChange(newVal);
    requestAnimationFrame(() => {
      const el = getTA();
      if (el) { const p = triggerPos + text.length; el.selectionStart = p; el.selectionEnd = p; el.focus(); }
    });
  }, [value, onChange, getTA]);

  const selectWiki = useCallback((entry: EditorEntry) => {
    insertAt(`[[${entry.title || extractTitle(entry.content)}]]`, wikiTrigger);
    setWikiOpen(false); setWikiQuery('');
  }, [wikiTrigger, insertAt]);

  const selectSlash = useCallback((cmd: SlashCmd) => {
    if ('triggerWikiLink' in cmd && cmd.triggerWikiLink) {
      insertAt('[[', slashTrigger);
      setSlashOpen(false); setSlashQuery('');
      requestAnimationFrame(() => {
        const ta = getTA();
        if (!ta) return;
        setWikiTrigger(slashTrigger); setWikiOpen(true); setWikiQuery(''); setWikiIdx(0);
        updatePopoverPos(ta, ta.selectionStart, setWikiPos);
      });
      return;
    }
    insertAt(cmd.syntax, slashTrigger);
    setSlashOpen(false); setSlashQuery('');
  }, [slashTrigger, insertAt, getTA]);

  keydownRef.current = (e: KeyboardEvent) => {
    if (wikiOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setWikiIdx((i) => Math.min(i + 1, filteredEntries.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setWikiIdx((i) => Math.max(i - 1, 0)); }
      else if (e.key === 'Enter' && filteredEntries[wikiIdx]) { e.preventDefault(); selectWiki(filteredEntries[wikiIdx]); }
      else if (e.key === 'Escape') { e.preventDefault(); setWikiOpen(false); }
      return;
    }
    if (slashOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => Math.min(i + 1, filteredCmds.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => Math.max(i - 1, 0)); }
      else if (e.key === 'Enter' && filteredCmds[slashIdx]) { e.preventDefault(); selectSlash(filteredCmds[slashIdx]); }
      else if (e.key === 'Escape') { e.preventDefault(); setSlashOpen(false); }
    }
  };

  function updatePopoverPos(ta: HTMLTextAreaElement, cursor: number, setPos: (p: { top: number; left: number }) => void) {
    const coords = getCursorCoords(ta, cursor);
    const taRect = ta.getBoundingClientRect();
    const cRect = containerRef.current?.getBoundingClientRect();
    if (cRect) {
      const lh = parseInt(getComputedStyle(ta).lineHeight || '20');
      setPos({ top: taRect.top - cRect.top + coords.top + lh, left: taRect.left - cRect.left + coords.left });
    }
  }

  const handleChange = useCallback((newVal: string | undefined) => {
    const val = newVal ?? '';
    onChange(val);
    requestAnimationFrame(() => {
      const ta = getTA();
      if (!ta) return;
      const cursor = ta.selectionStart;
      const before = val.substring(0, cursor);

      const wikiMatch = before.match(/\[\[([^\]]*?)$/);
      if (wikiMatch) {
        setWikiTrigger(cursor - wikiMatch[0].length);
        setWikiQuery(wikiMatch[1]); setWikiIdx(0);
        if (!wikiOpen) setWikiOpen(true);
        updatePopoverPos(ta, cursor, setWikiPos);
        return;
      } else if (wikiOpen) { setWikiOpen(false); setWikiQuery(''); }

      const lastNL = before.lastIndexOf('\n');
      const line = before.substring(lastNL + 1);
      if (/^\/(\S*)$/.test(line)) {
        setSlashTrigger(cursor - line.length);
        setSlashQuery(line.substring(1)); setSlashIdx(0);
        if (!slashOpen) setSlashOpen(true);
        updatePopoverPos(ta, cursor, setSlashPos);
        return;
      } else if (slashOpen) { setSlashOpen(false); setSlashQuery(''); }
    });
  }, [onChange, getTA, wikiOpen, slashOpen]);

  useEffect(() => {
    const ta = getTA();
    if (!ta) return;
    function handleKeyDown(e: KeyboardEvent) { keydownRef.current(e); }
    ta.addEventListener('keydown', handleKeyDown);
    return () => ta.removeEventListener('keydown', handleKeyDown);
  }, [getTA]);

  useEffect(() => {
    if (!wikiOpen && !slashOpen) return;
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current?.contains(e.target as Node)) return;
      if (wikiOpen) { setWikiOpen(false); setWikiQuery(''); }
      if (slashOpen) { setSlashOpen(false); setSlashQuery(''); }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [wikiOpen, slashOpen]);

  return (
    <div ref={containerRef} className="relative" data-color-mode={colorMode}>
      <MDEditor value={value} onChange={handleChange} height={height} preview="live" aria-label="编辑知识内容" />

      {wikiOpen && (
        <div className="absolute z-50 w-72 rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
          style={{ top: wikiPos.top, left: wikiPos.left }}>
          <div className="max-h-60 overflow-y-auto p-1">
            {filteredEntries.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">{wikiQuery ? '没有匹配的条目' : '暂无知识条目'}</div>
            ) : filteredEntries.map((entry, i) => (
              <button key={entry.id}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${i === wikiIdx ? 'bg-violet-50 text-violet-900 dark:bg-violet-900/30 dark:text-violet-200' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                onMouseDown={(e) => { e.preventDefault(); selectWiki(entry); }}
                onMouseEnter={() => setWikiIdx(i)}>
                {entry.title || extractTitle(entry.content)}
              </button>
            ))}
          </div>
        </div>
      )}

      {slashOpen && (
        <div className="absolute z-50 w-56 rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
          style={{ top: slashPos.top, left: slashPos.left }}>
          <div className="max-h-72 overflow-y-auto p-1">
            {filteredCmds.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">无匹配命令</div>
            ) : filteredCmds.map((cmd, i) => (
              <button key={cmd.label}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${i === slashIdx ? 'bg-violet-50 text-violet-900 dark:bg-violet-900/30 dark:text-violet-200' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                onMouseDown={(e) => { e.preventDefault(); selectSlash(cmd); }}
                onMouseEnter={() => setSlashIdx(i)}>
                <span className="flex h-6 w-6 items-center justify-center rounded bg-slate-100 text-xs font-mono dark:bg-slate-800">{cmd.icon}</span>
                {cmd.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
