/**
 * ContextInjector — 根据当前任务上下文，从 Repository 拉取相关知识条目注入
 *
 * 编排流程：Repository.search → RelevanceScorer → InjectionFormatter → InjectionPolicy → 组装响应
 * 对应 arc42 §5 Intent Enhancer 域 E 的 ContextInjector（FR-E01）
 */

import type { KnowledgeType, KnowledgeSource, KnowledgeEntry } from '../types/index.js';
import type { KnowledgeRepository } from '../repository/index.js';
import { RelevanceScorer, type RelevanceScorerOptions, type ScoredEntry } from './relevance-scorer.js';
import { InjectionFormatter, type InjectionFormat, type DisclosureMode } from './injection-formatter.js';
import { InjectionPolicy } from './injection-policy.js';
import { assessInjectionValue } from '../pipeline/value-gate.js';

export interface InjectionRequest {
  userQuery: string;
  tokenBudget: number;
  preferredTypes?: KnowledgeType[];
  format?: InjectionFormat;
  minScore?: number;
  topK?: number;
  /**
   * Disclosure mode for progressive disclosure.
   * - 'summary': inject one-line descriptions only (saves tokens, for system prompt)
   * - 'full': inject complete content (for deep context)
   * Default: 'full'
   */
  disclosureMode?: DisclosureMode;
}

export interface InjectionResponse {
  injectedContext: string;
  entries: Array<{
    entryId: string;
    type: KnowledgeType;
    summary: string;
    sourceRef: KnowledgeSource;
  }>;
  tokensUsed: number;
  truncated: boolean;
  /** The disclosure mode used for this injection */
  disclosureMode: DisclosureMode;
}

/** Interface for any scorer compatible with ContextInjector */
export interface ScorerLike {
  score(query: string, entries: KnowledgeEntry[]): Promise<ScoredEntry[]>;
}

export interface ContextInjectorOptions {
  repository: KnowledgeRepository;
  scorer?: RelevanceScorerOptions;
  /** Optional pre-built scorer instance (e.g. SemanticRelevanceScorer). Takes precedence over `scorer` options. */
  scorerInstance?: ScorerLike;
  defaultFormat?: InjectionFormat;
  defaultTopK?: number;
  /** Enable FR-E05 AC6 injection value gate (LLM-based). Default: false */
  enableValueGate?: boolean;
}

export class ContextInjector {
  private readonly repository: KnowledgeRepository;
  private readonly scorer: ScorerLike;
  private readonly defaultFormat: InjectionFormat;
  private readonly defaultTopK: number;
  private readonly enableValueGate: boolean;

  constructor(options: ContextInjectorOptions) {
    this.repository = options.repository;
    this.scorer = options.scorerInstance ?? new RelevanceScorer(options.scorer);
    this.defaultFormat = options.defaultFormat ?? 'markdown';
    this.defaultTopK = options.defaultTopK ?? 20;
    this.enableValueGate = options.enableValueGate ?? false;
  }

  async inject(request: InjectionRequest): Promise<InjectionResponse> {
    const {
      userQuery,
      tokenBudget,
      preferredTypes,
      format = this.defaultFormat,
      minScore = 0.1,
      topK = this.defaultTopK,
      disclosureMode = 'full',
    } = request;

    // 1. 从 Repository 检索候选条目
    const candidates = await this.repository.search({
      text: userQuery,
      filters: preferredTypes ? { types: preferredTypes } : undefined,
      topK,
    });

    if (candidates.length === 0) {
      return { injectedContext: '', entries: [], tokensUsed: 0, truncated: false, disclosureMode };
    }

    const entries = candidates.map(c => c.entry);

    // 2. 相关性评分
    const scored = await this.scorer.score(userQuery, entries);

    // 2.5 FR-E05 AC6: Injection value gate — filter out common knowledge
    let filteredEntries = entries;
    if (this.enableValueGate) {
      const valueChecks = await Promise.allSettled(
        entries.map(async (entry) => {
          const result = await assessInjectionValue(userQuery, entry.title, entry.content);
          return { entryId: entry.id, shouldInject: result.shouldInject, reasoning: result.reasoning };
        }),
      );
      const rejectedIds = new Set<string>();
      for (const check of valueChecks) {
        if (check.status === 'fulfilled' && !check.value.shouldInject) {
          rejectedIds.add(check.value.entryId);
        }
        // On failure, keep the entry (fail-open)
      }
      if (rejectedIds.size > 0) {
        filteredEntries = entries.filter(e => !rejectedIds.has(e.id));
      }
    }

    // 3. 格式化所有候选（使用指定的披露模式）
    const formatter = new InjectionFormatter(format, disclosureMode);
    const blocks = formatter.formatEntries(filteredEntries);

    // 4. 应用注入策略（token 预算 + 优先级 + 去重）
    const policy = new InjectionPolicy({
      maxTokens: tokenBudget,
      preferredTypes,
      minScore,
    });
    const result = policy.apply(scored, blocks);

    // 5. 组装响应
    const injectedContext = result.selected.map(b => b.text).join('\n\n---\n\n');

    const selectedIds = new Set(result.selected.map(b => b.entryId));
    const responseEntries = entries
      .filter(e => selectedIds.has(e.id))
      .map(e => ({
        entryId: e.id,
        type: e.type,
        summary: e.summary,
        sourceRef: e.source,
      }));

    return {
      injectedContext,
      entries: responseEntries,
      tokensUsed: result.tokensUsed,
      truncated: result.truncated,
      disclosureMode,
    };
  }

  /**
   * Load full content for a specific entry by ID.
   * Used in progressive disclosure: after summary-only injection,
   * the agent can request full content for entries it needs.
   */
  async injectById(entryId: string, format?: InjectionFormat, maxTokens?: number): Promise<InjectionResponse | null> {
    const entry = await this.repository.findById(entryId);
    if (!entry) return null;

    const formatter = new InjectionFormatter(format ?? this.defaultFormat, 'full');
    const block = formatter.formatEntry(entry);

    // Apply token budget control if maxTokens is specified
    let injectedContext = block.text;
    let tokensUsed = block.estimatedTokens;
    let truncated = false;

    if (maxTokens !== undefined && tokensUsed > maxTokens) {
      // Truncate to fit within budget (~4 chars per token)
      const maxChars = maxTokens * 4;
      injectedContext = injectedContext.slice(0, maxChars) + '\n[truncated]';
      tokensUsed = maxTokens;
      truncated = true;
    }

    return {
      injectedContext,
      entries: [{
        entryId: entry.id,
        type: entry.type,
        summary: entry.summary,
        sourceRef: entry.source,
      }],
      tokensUsed,
      truncated,
      disclosureMode: 'full',
    };
  }
}
