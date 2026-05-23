/**
 * FR-1 AC-1.1, AC-1.6, AC-1.7, NFR-1
 * URL collection: fetch page content, extract readable text, ask LLM for a wiki draft.
 */

import { randomUUID } from 'node:crypto';
import type { CollectorContext, UrlCollectInput, WikiCollectionResult, WikiDraft, WikiDraftInput, WikiPageSection } from '../types.js';

export const DEFAULT_TIMEOUT_MS = 20_000;

export class UrlCollector {
  async collect(input: UrlCollectInput, context: CollectorContext): Promise<WikiCollectionResult> {
    const startedAt = Date.now();
    const fetched = await fetchUrl(input.url, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const content = htmlToText(fetched.body);

    if (!content.trim()) {
      throw new Error(`URL ${input.url} produced no readable content`);
    }

    const draft = await buildDraft(
      {
        title: fetched.title || input.url,
        content,
        spaceId: input.spaceId,
        source: {
          type: 'url',
          uri: input.url,
          collectedAt: (context.now ?? new Date()).toISOString(),
        },
      },
      context,
    );

    return {
      draft,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function fetchUrl(url: string, timeoutMs: number): Promise<{ title: string; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'KIVO-LLM-Wiki/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Fetch failed with ${response.status} ${response.statusText}`);
    }
    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return {
      title: titleMatch?.[1]?.trim() ?? '',
      body: html,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`URL collection failed for ${url}: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildDraft(input: WikiDraftInput & { spaceId?: string }, context: CollectorContext): Promise<WikiDraft> {
  const prompt = [
    'You are converting raw source material into a structured wiki draft for an AI knowledge base.',
    'Return strict JSON with keys: title, summary, tags, sections, suggestedParentTitle, links, warnings.',
    'Each section must include title, level, content.',
    'Each link must include label and targetTitle, inferred from [[Title]] style mentions or explicit references.',
    'Preserve factual content. Do not invent sources.',
  ].join('\n');

  const fallbackTitle = input.title ?? inferTitle(input.content);
  let llmRaw = '';
  let structured: ReturnType<typeof parseStructuredDraft>;
  try {
    llmRaw = await withTimeout(
      (signal) => context.llm.complete({
        model: context.model,
        prompt,
        content: input.content,
        signal,
      }),
      context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'LLM draft generation',
    );
    structured = parseStructuredDraft(llmRaw, fallbackTitle);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    structured = {
      title: fallbackTitle,
      summary: '',
      tags: [],
      sections: fallbackSections(input.content, fallbackTitle),
      suggestedParentTitle: undefined,
      links: [],
      warnings: [`LLM unavailable; generated a readable raw draft instead: ${reason}`],
      raw: { fallback: true, reason },
    };
  }
  const rawSections = structured.sections.length > 0 ? structured.sections : fallbackSections(input.content, input.title);
  const renderedContent = renderSections(rawSections);

  return {
    id: randomUUID(),
    title: structured.title,
    summary: structured.summary,
    content: renderedContent,
    tags: structured.tags,
    sections: rawSections,
    links: structured.links,
    suggestedParentTitle: structured.suggestedParentTitle,
    suggestedSpaceId: input.spaceId,
    source: input.source,
    rawContent: input.content,
    llmOutput: structured.raw,
    status: 'pending_confirmation',
    errors: [],
    warnings: structured.warnings,
    createdAt: (context.now ?? new Date()).toISOString(),
  };
}


export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function parseStructuredDraft(raw: string, fallbackTitle: string): {
  title: string;
  summary: string;
  tags: string[];
  sections: WikiPageSection[];
  suggestedParentTitle?: string;
  links: Array<{ label: string; targetTitle: string; status: 'resolved' | 'missing' }>;
  warnings: string[];
  raw: Record<string, unknown>;
} {
  const parsed = safeParseJson(raw);
  const title = stringOr(parsed.title, fallbackTitle);
  const summary = stringOr(parsed.summary, '');
  const tags = arrayOfStrings(parsed.tags);
  const warnings = arrayOfStrings(parsed.warnings);
  const suggestedParentTitle = typeof parsed.suggestedParentTitle === 'string' ? parsed.suggestedParentTitle : undefined;
  const sections = Array.isArray(parsed.sections)
    ? parsed.sections
        .map((section) => {
          if (!section || typeof section !== 'object') return null;
          const record = section as Record<string, unknown>;
          const content = stringOr(record.content, '');
          if (!content.trim()) return null;
          return {
            title: stringOr(record.title, ''),
            level: numberOr(record.level, 1),
            content,
          };
        })
        .filter((section): section is WikiPageSection => section !== null)
    : [];
  const links = Array.isArray(parsed.links)
    ? parsed.links
        .map((link) => {
          if (!link || typeof link !== 'object') return null;
          const record = link as Record<string, unknown>;
          const targetTitle = stringOr(record.targetTitle, '');
          if (!targetTitle) return null;
          return {
            label: stringOr(record.label, targetTitle),
            targetTitle,
            status: 'missing' as const,
          };
        })
        .filter((link): link is { label: string; targetTitle: string; status: 'missing' } => link !== null)
    : [];

  return {
    title,
    summary,
    tags,
    sections,
    suggestedParentTitle,
    links,
    warnings,
    raw: parsed,
  };
}

function safeParseJson(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  try {
    const parsed = JSON.parse(fenced);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function inferTitle(content: string): string {
  const firstLine = content.split('\n').map((line) => line.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 120) : 'Untitled wiki draft';
}

function fallbackSections(content: string, title?: string): WikiPageSection[] {
  const blocks = content.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length === 0) {
    return [{ title: title ?? 'Overview', level: 1, content }];
  }
  return blocks.map((block, index) => ({
    title: index === 0 ? title ?? 'Overview' : '',
    level: 1,
    content: block,
  }));
}

function renderSections(sections: WikiPageSection[]): string {
  return sections
    .map((section) => {
      const heading = section.title ? `${'#'.repeat(Math.max(1, Math.min(section.level, 6)))} ${section.title}\n\n` : '';
      return `${heading}${section.content.trim()}`;
    })
    .join('\n\n');
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|section|article|h\d|li|blockquote|pre)>/gi, '$&\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}
