'use client';

import { useEffect, useMemo, useRef } from 'react';

declare global {
  interface Window {
    MathJax?: {
      startup?: { promise?: Promise<void> };
      typesetPromise?: (elements?: HTMLElement[]) => Promise<void>;
      tex?: unknown;
      options?: unknown;
    };
  }
}

interface SourceRef {
  label?: string;
  uri?: string;
  page?: number | string;
  paragraph?: string;
}

interface ContentRendererProps {
  content: string;
  sourceRefs?: SourceRef[];
}

const MATHJAX_SCRIPT_ID = 'kivo-mathjax-script';

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSourceRef(ref: SourceRef) {
  const parts = [];
  if (ref.label) parts.push(ref.label);
  if (ref.page !== undefined && ref.page !== null && String(ref.page).trim()) parts.push(`第 ${ref.page} 页`);
  if (ref.paragraph) parts.push(`段落 ${ref.paragraph}`);
  return parts.join(' · ') || ref.uri || '来源';
}

type BlockType = 'heading2' | 'heading3' | 'heading4' | 'paragraph' | 'image' | 'displayMath' | 'codeBlock' | 'list';

interface ParsedBlock {
  type: BlockType;
  text: string;
  html: string;
}

function parseContentBlocks(content: string): ParsedBlock[] {
  const lines = content.split('\n');
  const blocks: ParsedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^##\s+(.+)/.test(line)) {
      const text = line.replace(/^##\s+/, '');
      blocks.push({ type: 'heading2', text, html: escapeHtml(text) });
      i++;
      continue;
    }

    if (/^###\s+(.+)/.test(line)) {
      const text = line.replace(/^###\s+/, '');
      blocks.push({ type: 'heading3', text, html: escapeHtml(text) });
      i++;
      continue;
    }

    if (/^####\s+(.+)/.test(line)) {
      const text = line.replace(/^####\s+/, '');
      blocks.push({ type: 'heading4', text, html: escapeHtml(text) });
      i++;
      continue;
    }

    if (/^```/.test(line)) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: 'codeBlock', text: codeLines.join('\n'), html: escapeHtml(codeLines.join('\n')) });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const listLines: string[] = [];
      while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]))) {
        listLines.push(lines[i].replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', text: listLines.join('\n'), html: listLines.map((item) => escapeHtml(item)).join('<br/>') });
      continue;
    }

    if (/^\$\$[\s\S]*\$\$$/.test(line) && line.trim().startsWith('$$') && line.trim().endsWith('$$')) {
      blocks.push({ type: 'displayMath', text: line, html: escapeHtml(line) });
      i++;
      continue;
    }

    const imgMatch = line.match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/);
    if (imgMatch) {
      blocks.push({
        type: 'image',
        text: line,
        html: `<img src="${imgMatch[2]}" alt="${escapeHtml(imgMatch[1])}" class="my-3 max-h-[28rem] rounded-xl border border-slate-200 object-contain shadow-sm" />`,
      });
      i++;
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^##/.test(lines[i]) && !/^```/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
      const l = lines[i].trim();
      if (l) paraLines.push(l);
      i++;
    }
    if (paraLines.length > 0) {
      const htmlText = paraLines.map((p) => escapeHtml(p).replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold">$1</strong>')).join('<br/>');
      blocks.push({ type: 'paragraph', text: paraLines.join('\n'), html: htmlText });
    }
  }

  return blocks;
}

export function ContentRenderer({ content, sourceRefs = [] }: ContentRendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.MathJax = {
      ...(window.MathJax ?? {}),
      tex: {
        inlineMath: [['$', '$'], ['\\(', '\\)']],
        displayMath: [['$$', '$$'], ['\\[', '\\]']],
        processEscapes: true,
      },
      options: {
        skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
      },
    };
    if (document.getElementById(MATHJAX_SCRIPT_ID)) {
      const element = containerRef.current;
      if (element && window.MathJax?.typesetPromise) {
        const startup = window.MathJax.startup?.promise ?? Promise.resolve();
        void startup.then(() => window.MathJax?.typesetPromise?.([element])).catch(() => undefined);
      }
      return;
    }
    const script = document.createElement('script');
    script.id = MATHJAX_SCRIPT_ID;
    script.async = true;
    script.src = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js';
    script.onload = () => {
      const element = containerRef.current;
      if (!element || !window.MathJax?.typesetPromise) return;
      const startup = window.MathJax.startup?.promise ?? Promise.resolve();
      void startup.then(() => window.MathJax?.typesetPromise?.([element])).catch(() => undefined);
    };
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !window.MathJax?.typesetPromise) return;
    const startup = window.MathJax.startup?.promise ?? Promise.resolve();
    void startup.then(() => window.MathJax?.typesetPromise?.([element])).catch(() => undefined);
  }, [content]);

  const blocks = useMemo(() => parseContentBlocks(content), [content]);

  return (
    <div ref={containerRef} className="space-y-4 text-sm leading-7 text-slate-800">
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading2':
            return (
              <h2
                key={`h2-${index}`}
                className="pb-2 pt-4 text-xl font-semibold text-slate-950 border-b border-slate-100"
                dangerouslySetInnerHTML={{ __html: block.html }}
              />
            );
          case 'heading3':
            return (
              <h3
                key={`h3-${index}`}
                className="pt-3 text-lg font-semibold text-slate-950"
                dangerouslySetInnerHTML={{ __html: block.html }}
              />
            );
          case 'heading4':
            return (
              <h4
                key={`h4-${index}`}
                className="pt-2 text-base font-medium text-slate-900"
                dangerouslySetInnerHTML={{ __html: block.html }}
              />
            );
          case 'displayMath':
            return (
              <div
                key={`math-${index}`}
                className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-center"
                dangerouslySetInnerHTML={{ __html: block.html }}
              />
            );
          case 'image':
            return <div key={`img-${index}`} dangerouslySetInnerHTML={{ __html: block.html }} />;
          case 'codeBlock':
            return (
              <pre
                key={`code-${index}`}
                className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-6 text-slate-800"
                dangerouslySetInnerHTML={{ __html: block.html }}
              />
            );
          case 'list':
            return (
              <div
                key={`list-${index}`}
                className="space-y-1 rounded-xl bg-white px-2"
                dangerouslySetInnerHTML={{ __html: `<ul class="list-disc list-inside space-y-1 text-slate-700">${block.html.split('<br/>').map((item) => `<li class="text-sm">${item}</li>`).join('')}</ul>` }}
              />
            );
          default:
            return (
              <p
                key={`p-${index}`}
                className="rounded-xl bg-white whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ __html: block.html }}
              />
            );
        }
      })}

      {sourceRefs.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">来源材料</h3>
          <div className="mt-3 space-y-2">
            {sourceRefs.map((ref, index) => {
              const href = ref.uri || '#';
              return (
                <a
                  key={`${href}-${index}`}
                  href={href}
                  target={ref.uri ? '_blank' : undefined}
                  rel={ref.uri ? 'noreferrer' : undefined}
                  className="block rounded-xl border border-white bg-white px-3 py-2 text-sm text-slate-700 transition-colors hover:border-slate-300 hover:text-slate-950"
                >
                  {formatSourceRef(ref)}
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
