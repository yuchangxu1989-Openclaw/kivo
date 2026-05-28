/**
 * InjectionFormatter — 将知识条目格式化为可注入的文本块
 * 支持 markdown 和 plain text 两种输出格式
 * 支持 summary-only 和 full-content 两种披露模式（渐进式披露）
 */

import type { KnowledgeEntry } from '../types/index.js';

export type InjectionFormat = 'markdown' | 'plain';

/**
 * Disclosure mode — controls how much content is injected.
 * - 'summary': inject only a one-line description (saves tokens)
 * - 'full': inject complete content (for deep context)
 */
export type DisclosureMode = 'summary' | 'full';

export interface FormattedBlock {
  text: string;
  entryId: string;
  estimatedTokens: number;
  /** The disclosure mode used to produce this block */
  disclosureMode: DisclosureMode;
}

export class InjectionFormatter {
  private readonly format: InjectionFormat;
  private readonly disclosureMode: DisclosureMode;

  constructor(format: InjectionFormat = 'markdown', disclosureMode: DisclosureMode = 'full') {
    this.format = format;
    this.disclosureMode = disclosureMode;
  }

  formatEntry(entry: KnowledgeEntry, modeOverride?: DisclosureMode): FormattedBlock {
    const mode = modeOverride ?? this.disclosureMode;
    const text = this.format === 'markdown'
      ? (mode === 'summary' ? this.formatMarkdownSummary(entry) : this.formatMarkdown(entry))
      : (mode === 'summary' ? this.formatPlainSummary(entry) : this.formatPlain(entry));

    return {
      text,
      entryId: entry.id,
      estimatedTokens: estimateTokens(text),
      disclosureMode: mode,
    };
  }

  formatEntries(entries: KnowledgeEntry[], modeOverride?: DisclosureMode): FormattedBlock[] {
    return entries.map(e => this.formatEntry(e, modeOverride));
  }

  private formatMarkdown(entry: KnowledgeEntry): string {
    const lines: string[] = [
      `### ${entry.title}`,
      `> **类型**: ${entry.type} | **置信度**: ${entry.confidence}`,
      '',
      entry.summary || entry.content,
      '',
      `_来源: ${entry.source.reference}_`,
    ];
    return lines.join('\n');
  }

  /**
   * Summary-only markdown: one-line description for system prompt injection.
   * Full content loaded on demand via ContextInjector.injectById().
   */
  private formatMarkdownSummary(entry: KnowledgeEntry): string {
    const categoryTag = entry.category ? ` [${entry.category}]` : '';
    return `- **${entry.title}**${categoryTag} (${entry.type}, ×${entry.confidence}) — ${entry.summary || truncate(entry.content, 120)} \`id:${entry.id}\``;
  }

  private formatPlain(entry: KnowledgeEntry): string {
    const lines: string[] = [
      `[${entry.type.toUpperCase()}] ${entry.title}`,
      entry.summary || entry.content,
      `(来源: ${entry.source.reference})`,
    ];
    return lines.join('\n');
  }

  /**
   * Summary-only plain text: compact single line.
   */
  private formatPlainSummary(entry: KnowledgeEntry): string {
    const categoryTag = entry.category ? ` [${entry.category}]` : '';
    return `[${entry.type.toUpperCase()}]${categoryTag} ${entry.title} — ${entry.summary || truncate(entry.content, 120)} (id:${entry.id})`;
  }
}

/** 简易 token 估算：~4 字符 ≈ 1 token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate text to maxLen chars, appending '…' if truncated */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}
