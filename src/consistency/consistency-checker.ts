/**
 * ConsistencyChecker — FR-Z09 知识条目一致性检测
 *
 * AC1: README/Quick Start 示例代码纳入 CI 校验（由 doc-gate 覆盖）
 * AC2: API 签名变更时文档同步更新（由 doc-gate 覆盖）
 *
 * 本模块补充：知识条目之间的语义一致性检测
 * - 同类型条目内容矛盾检测（polarity 冲突）
 * - 过期引用检测（引用已归档/已废弃条目）
 * - 语义漂移检测（同主题条目内容差异过大）
 */

import type { KnowledgeEntry } from '../types/index.js';
import type {
  ConsistencyCheckOptions,
  ConsistencyIssue,
  ConsistencyReport,
} from './consistency-types.js';

export class ConsistencyChecker {
  private readonly defaultThreshold = 0.6;

  /**
   * Run a full consistency check across all provided entries.
   * Returns a report with issues found and pass/fail status.
   */
  check(entries: KnowledgeEntry[], options: ConsistencyCheckOptions = {}): ConsistencyReport {
    const threshold = options.similarityThreshold ?? this.defaultThreshold;
    const strict = options.strict ?? false;
    const now = new Date();

    // Filter entries by type/domain if specified
    let filtered = entries;
    if (options.types && options.types.length > 0) {
      filtered = filtered.filter(e => options.types!.includes(e.type));
    }
    if (options.domains && options.domains.length > 0) {
      filtered = filtered.filter(e => e.domain && options.domains!.includes(e.domain));
    }

    const activeEntries = filtered.filter(e => e.status === 'active');
    const allEntries = filtered;

    const issues: ConsistencyIssue[] = [];
    let pairsCompared = 0;
    let issueCounter = 0;

    // 1. Contradiction detection: same-type active entries with opposing polarity
    for (let i = 0; i < activeEntries.length; i++) {
      for (let j = i + 1; j < activeEntries.length; j++) {
        const a = activeEntries[i];
        const b = activeEntries[j];
        if (a.type !== b.type) continue;

        pairsCompared++;
        const similarity = this.textSimilarity(a.content, b.content);

        if (similarity >= threshold) {
          const polarityA = this.detectPolarity(a.content);
          const polarityB = this.detectPolarity(b.content);

          if (polarityA !== 'neutral' && polarityB !== 'neutral' && polarityA !== polarityB) {
            issueCounter++;
            issues.push({
              id: `consistency-${issueCounter}`,
              severity: 'error',
              category: 'contradiction',
              entryIdA: a.id,
              titleA: a.title,
              entryIdB: b.id,
              titleB: b.title,
              description: `Contradicting entries: "${a.title}" (${polarityA}) vs "${b.title}" (${polarityB})`,
              similarityScore: similarity,
            });
          }

          // Semantic drift: high topic similarity but low content overlap
          if (similarity >= threshold && similarity < 0.85) {
            const titleSim = this.textSimilarity(a.title, b.title);
            if (titleSim >= 0.7) {
              issueCounter++;
              issues.push({
                id: `consistency-${issueCounter}`,
                severity: 'warning',
                category: 'semantic-drift',
                entryIdA: a.id,
                titleA: a.title,
                entryIdB: b.id,
                titleB: b.title,
                description: `Similar titles but diverging content: "${a.title}" vs "${b.title}" (similarity: ${similarity.toFixed(2)})`,
                similarityScore: similarity,
              });
            }
          }
        }
      }
    }

    // 2. Stale reference detection: entries with broken dependency references
    const entryMap = new Map(allEntries.map(e => [e.id, e]));
    for (const entry of activeEntries) {
      // Check dependency references
      if (entry.dependencies) {
        for (const dep of entry.dependencies) {
          const target = entryMap.get(dep.ref);
          if (!target) {
            issueCounter++;
            issues.push({
              id: `consistency-${issueCounter}`,
              severity: dep.relation === 'requires' ? 'error' : 'warning',
              category: 'stale-reference',
              entryIdA: entry.id,
              titleA: entry.title,
              entryIdB: dep.ref,
              titleB: dep.ref,
              description: `Entry "${entry.title}" ${dep.relation} "${dep.ref}" which does not exist`,
            });
          }
        }
      }
    }

    // 3. Missing source detection: entries with empty or placeholder sources
    for (const entry of activeEntries) {
      if (!entry.source.reference || entry.source.reference === 'unknown' || entry.source.reference === '') {
        issueCounter++;
        issues.push({
          id: `consistency-${issueCounter}`,
          severity: 'warning',
          category: 'missing-source',
          entryIdA: entry.id,
          titleA: entry.title,
          description: `Entry "${entry.title}" has no valid source reference`,
        });
      }
    }

    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.filter(i => i.severity === 'warning').length;
    const passed = strict ? (errors + warnings) === 0 : errors === 0;

    return {
      checkedAt: now,
      totalEntries: filtered.length,
      pairsCompared,
      issues,
      passed,
      summary: { errors, warnings },
    };
  }

  /**
   * Jaccard text similarity (same approach as ConflictDetector for consistency)
   */
  private textSimilarity(a: string, b: string): number {
    const tokensA = this.tokenize(a);
    const tokensB = this.tokenize(b);
    if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersection = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) intersection++;
    }
    const union = tokensA.size + tokensB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private tokenize(text: string): Set<string> {
    const normalized = text.toLowerCase();
    const words = normalized.match(/[\u4e00-\u9fff]+|[a-z0-9]+/g) ?? [];
    const tokens = new Set<string>();
    for (const word of words) {
      // Split CJK runs into bigrams for meaningful comparison
      if (/^[\u4e00-\u9fff]+$/.test(word)) {
        for (let i = 0; i < word.length; i++) {
          tokens.add(word[i]);
          if (i < word.length - 1) {
            tokens.add(word.slice(i, i + 2));
          }
        }
      } else {
        tokens.add(word);
      }
    }
    return tokens;
  }

  /**
   * Detect polarity: allow/deny/neutral
   */
  private detectPolarity(text: string): 'allow' | 'deny' | 'neutral' {
    const normalized = text.toLowerCase();

    if (/(must not|should not|cannot|can't|never|forbid|forbidden|deny|denied|禁止|不得|不允许|不可|不能)/u.test(normalized)) {
      return 'deny';
    }

    if (/(must|should|always|required|allow|allowed|permit|permitted|必须|应当|需要|允许|可以)/u.test(normalized)) {
      return 'allow';
    }

    return 'neutral';
  }
}
