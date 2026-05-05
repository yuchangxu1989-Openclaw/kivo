/**
 * TermInjectionStrategy — 术语专用 Prompt 注入
 * FR-H02
 *
 * 优先级提升 + deprecated 提示 + 术语专用格式化模板
 */

import type { KnowledgeEntry } from '../types/index.js';
import type { StorageAdapter, KnowledgeFilter } from '../storage/storage-types.js';
import type { ScoredEntry } from '../injection/relevance-scorer.js';
import type { FormattedBlock } from '../injection/injection-formatter.js';
import { estimateTokens } from '../injection/injection-formatter.js';
import type { TermMetadata, DictionaryConfig } from './term-types.js';
import { DEFAULT_DICTIONARY_CONFIG, DICTIONARY_DOMAIN } from './term-types.js';

export interface TermInjectionStrategyOptions {
  store: StorageAdapter;
  config?: Partial<DictionaryConfig>;
}

export interface TermInjectionResult {
  blocks: FormattedBlock[];
  deprecatedWarnings: FormattedBlock[];
}

export class TermInjectionStrategy {
  private readonly store: StorageAdapter;
  private readonly config: DictionaryConfig;

  constructor(options: TermInjectionStrategyOptions) {
    this.store = options.store;
    this.config = { ...DEFAULT_DICTIONARY_CONFIG, ...options.config };
  }

  /**
   * 从 query 中检索相关术语并格式化为注入块
   * 返回活跃术语块 + deprecated 警告块
   */
  async getTermBlocks(query: string, options: { format?: 'markdown' | 'plaintext'; tokenBudget?: number } = {}): Promise<TermInjectionResult> {
    const allTerms = await this.queryDictionaryEntries();
    const blocks: FormattedBlock[] = [];
    const deprecatedWarnings: FormattedBlock[] = [];
    const format = options.format ?? 'markdown';

    // 精确匹配：query 中出现的术语名或别名
    const queryLower = query.toLowerCase();
    const matched = new Set<string>();

    for (const entry of allTerms) {
      const meta = entry.metadata as TermMetadata | undefined;
      if (!meta) continue;

      const names = [meta.term, ...meta.aliases];
      const isExactMatch = names.some(n => queryLower.includes(n.toLowerCase()));

      if (!isExactMatch) continue;
      matched.add(entry.id);

      if (entry.status === 'deprecated') {
        deprecatedWarnings.push(this.formatDeprecatedWarning(entry, meta));
      } else if (entry.status === 'active') {
        blocks.push(this.formatTermBlock(entry, meta, format));
      }
    }

    const tokenBudget = options.tokenBudget ?? this.config.injection.maxTokens ?? Number.MAX_SAFE_INTEGER;
    const activeBudget = Number.isFinite(tokenBudget) ? tokenBudget : Number.MAX_SAFE_INTEGER;
    return {
      blocks: this.fitWithinBudget(blocks, activeBudget),
      deprecatedWarnings: this.fitWithinBudget(deprecatedWarnings, activeBudget, { allowSingleOversized: true }),
    };
  }

  /**
   * 将术语注入块与一般知识评分合并，术语优先级提升
   */
  boostTermScores(termEntries: KnowledgeEntry[], scored: ScoredEntry[]): ScoredEntry[] {
    const boost = this.config.injection.priorityBoost;
    const termIds = new Set(termEntries.map(e => e.id));

    return scored.map(s => {
      if (termIds.has(s.entry.id)) {
        return { entry: s.entry, score: s.score * boost };
      }
      return s;
    });
  }

  /** 术语专用 markdown 格式化 */
  formatTermBlock(entry: KnowledgeEntry, meta: TermMetadata, format: 'markdown' | 'plaintext' = 'markdown'): FormattedBlock {
    if (format === 'plaintext') return this.formatTermBlockPlainText(entry, meta);

    const lines: string[] = [
      `**📖 ${meta.term}**`,
      `> ${meta.definition}`,
    ];
    if (meta.constraints.length > 0) {
      lines.push('', '约束:');
      meta.constraints.forEach(c => lines.push(`- ${c}`));
    }
    if (meta.positiveExamples.length > 0) {
      lines.push('', '✅ 正例:');
      meta.positiveExamples.forEach(e => lines.push(`- ${e}`));
    }
    if (meta.negativeExamples.length > 0) {
      lines.push('', '❌ 负例:');
      meta.negativeExamples.forEach(e => lines.push(`- ${e}`));
    }

    const text = lines.join('\n');
    return { text, entryId: entry.id, estimatedTokens: estimateTokens(text), disclosureMode: 'full' };
  }

  /** 术语 plain text 格式化 (P1-3: FR-H02-AC4) */
  private formatTermBlockPlainText(entry: KnowledgeEntry, meta: TermMetadata): FormattedBlock {
    const lines: string[] = [
      `[${meta.term}]`,
      meta.definition,
    ];
    if (meta.constraints.length > 0) {
      lines.push('', '约束:');
      meta.constraints.forEach(c => lines.push(`  - ${c}`));
    }
    if (meta.positiveExamples.length > 0) {
      lines.push('', '正例:');
      meta.positiveExamples.forEach(e => lines.push(`  - ${e}`));
    }
    if (meta.negativeExamples.length > 0) {
      lines.push('', '负例:');
      meta.negativeExamples.forEach(e => lines.push(`  - ${e}`));
    }
    const text = lines.join('\n');
    return { text, entryId: entry.id, estimatedTokens: estimateTokens(text), disclosureMode: 'full' };
  }

  /** deprecated 术语警告格式化 */
  private formatDeprecatedWarning(entry: KnowledgeEntry, meta: TermMetadata): FormattedBlock {
    const metadata = entry.metadata as Record<string, unknown>;
    const reason = metadata?.deprecationReason ?? '未说明';
    const replacement = metadata?.deprecationReplacementTermId ? ` 替代术语：${String(metadata.deprecationReplacementTermId)}。` : '';
    const text = `⚠️ 术语「${meta.term}」已废弃。原因：${reason}。${replacement}请使用替代术语。`;
    return { text, entryId: entry.id, estimatedTokens: estimateTokens(text), disclosureMode: 'full' };
  }

  private fitWithinBudget(
    blocks: FormattedBlock[],
    tokenBudget: number,
    options: { allowSingleOversized?: boolean } = {},
  ): FormattedBlock[] {
    if (blocks.length === 0) return [];

    const selected: FormattedBlock[] = [];
    let used = 0;

    for (const block of blocks) {
      if (block.estimatedTokens > tokenBudget) {
        if (options.allowSingleOversized && selected.length === 0) {
          selected.push(block);
        }
        break;
      }
      if (used + block.estimatedTokens > tokenBudget) break;
      selected.push(block);
      used += block.estimatedTokens;
    }

    return selected;
  }

  private async queryDictionaryEntries(): Promise<KnowledgeEntry[]> {
    const filter: KnowledgeFilter = {
      domain: DICTIONARY_DOMAIN,
      type: 'fact',
    };
    const result = await this.store.query(filter);
    return result.items;
  }
}
