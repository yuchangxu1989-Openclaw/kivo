/**
 * FR-4 AC-4.3, AC-4.5 | NFR-4
 * Context builder: deduplicates, trims, and formats injection fragments
 * within a 4000-token budget.
 */

import type { WikiEntryRecord } from '../types.js';
import type { ScoredEntry } from './relevance-scorer.js';

export interface ContextFragment {
  id: string;
  title: string;
  content: string;
  score: number;
  tokenCount: number;
  source: 'domain' | 'intent';
}

export interface InjectionContext {
  fragments: ContextFragment[];
  totalTokens: number;
  truncated: boolean;
}

const DEFAULT_TOKEN_BUDGET = 4000;
const CHARS_PER_TOKEN = 4;

/**
 * Estimates token count from text (~4 chars per token for mixed CJK/English).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Formats a wiki entry into an injectable context fragment.
 */
function formatFragment(entry: WikiEntryRecord, score: number): ContextFragment {
  const content = `## ${entry.title}\n${entry.summary ? entry.summary + '\n\n' : ''}${entry.content}`;
  return {
    id: entry.id,
    title: entry.title,
    content,
    score,
    tokenCount: estimateTokens(content),
    source: 'domain',
  };
}

export class ContextBuilder {
  private tokenBudget: number;

  constructor(tokenBudget: number = DEFAULT_TOKEN_BUDGET) {
    this.tokenBudget = tokenBudget;
  }

  /**
   * Builds injection context from scored entries with deduplication and token budget.
   */
  build(scoredEntries: ScoredEntry[]): InjectionContext {
    const seen = new Set<string>();
    const fragments: ContextFragment[] = [];
    let totalTokens = 0;
    let truncated = false;

    // Reserve tokens for header
    const header = '# 领域知识参考\n\n';
    const headerTokens = estimateTokens(header);
    totalTokens += headerTokens;

    for (const { entry, score } of scoredEntries) {
      // Deduplicate by entry ID
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);

      const fragment = formatFragment(entry, score);

      // Check if adding this fragment exceeds budget
      if (totalTokens + fragment.tokenCount > this.tokenBudget) {
        const remainingTokens = this.tokenBudget - totalTokens;
        if (remainingTokens > 80) {
          // Trim content to fit remaining budget
          const maxChars = remainingTokens * CHARS_PER_TOKEN;
          const trimmedContent = fragment.content.slice(0, maxChars) + '…';
          fragments.push({
            ...fragment,
            content: trimmedContent,
            tokenCount: estimateTokens(trimmedContent),
          });
          totalTokens += estimateTokens(trimmedContent);
        }
        truncated = true;
        break;
      }

      fragments.push(fragment);
      totalTokens += fragment.tokenCount;
    }

    return { fragments, totalTokens, truncated };
  }

  /**
   * Renders the injection context as a formatted string for LLM consumption.
   */
  render(context: InjectionContext): string {
    if (context.fragments.length === 0) return '';

    let output = '# 领域知识参考\n\n';
    for (const fragment of context.fragments) {
      output += fragment.content + '\n\n---\n\n';
    }

    if (context.truncated) {
      output += '_[更多相关知识因 token 限制已省略]_\n';
    }

    return output.trim();
  }

  /**
   * Merges domain knowledge fragments with intent knowledge fragments,
   * deduplicating and respecting total budget.
   */
  merge(
    domainContext: InjectionContext,
    intentFragments: ContextFragment[],
  ): InjectionContext {
    const seen = new Set<string>(domainContext.fragments.map((f) => f.id));
    const merged = [...domainContext.fragments];
    let totalTokens = domainContext.totalTokens;
    let truncated = domainContext.truncated;

    for (const fragment of intentFragments) {
      if (seen.has(fragment.id)) continue;
      seen.add(fragment.id);

      if (totalTokens + fragment.tokenCount > this.tokenBudget) {
        truncated = true;
        break;
      }

      merged.push(fragment);
      totalTokens += fragment.tokenCount;
    }

    return { fragments: merged, totalTokens, truncated };
  }
}
