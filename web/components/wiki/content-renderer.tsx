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

function renderInline(text: string) {
  const html = escapeHtml(text).replace(
    /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
    '<img src="$2" alt="$1" class="my-3 max-h-[28rem] rounded-xl border border-slate-200 object-contain shadow-sm" />',
  );
  return { __html: html };
}

function formatSourceRef(ref: SourceRef) {
  const parts = [];
  if (ref.label) parts.push(ref.label);
  if (ref.page !== undefined && ref.page !== null && String(ref.page).trim()) parts.push(`第 ${ref.page} 页`);
  if (ref.paragraph) parts.push(`段落 ${ref.paragraph}`);
  return parts.join(' · ') || ref.uri || '来源';
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

  const blocks = useMemo(() => {
    return content
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean);
  }, [content]);

  return (
    <div ref={containerRef} className="space-y-4 text-sm leading-7 text-slate-800">
      {blocks.map((block, index) => {
        if (/^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/.test(block)) {
          return <div key={`block-${index}`} dangerouslySetInnerHTML={renderInline(block)} />;
        }

        if (/^\$\$[\s\S]*\$\$$/.test(block)) {
          return (
            <div
              key={`block-${index}`}
              className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-center"
              dangerouslySetInnerHTML={renderInline(block)}
            />
          );
        }

        return (
          <p
            key={`block-${index}`}
            className="rounded-xl bg-white whitespace-pre-wrap"
            dangerouslySetInnerHTML={renderInline(block)}
          />
        );
      })}

      {sourceRefs.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">PDF 来源引用</h3>
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
