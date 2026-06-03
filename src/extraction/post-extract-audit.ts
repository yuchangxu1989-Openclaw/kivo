/**
 * Post-Extract Audit (FR-N06)
 *
 * Integrates quality auditing into the cron batch extraction pipeline.
 * After extraction, each new entry is evaluated by LLM on three dimensions:
 *   - 时效性 (timeliness): Is this knowledge time-sensitive or evergreen?
 *   - 跨场景复用性 (cross-scenario reusability): Can it be applied broadly?
 *   - 抽象性 (abstraction level): Is it sufficiently generalized?
 *
 * Entries that fail are marked `pending_review` and excluded from active use.
 */

import type { KnowledgeEntry } from '../types/index.js';
import { OpenAILLMProvider, resolveLlmTimeoutMs } from './llm-extractor.js';
import { resolveLlmConfig } from '../cli/resolve-llm-config.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AuditDimension {
  /** Score 1-5 */
  score: number;
  /** LLM rationale for this dimension */
  rationale: string;
}

export interface AuditResult {
  entryId: string;
  title: string;
  timeliness: AuditDimension;
  reusability: AuditDimension;
  abstraction: AuditDimension;
  /** Average of three dimensions, rounded */
  overall: number;
  /** Whether the entry passes the audit threshold */
  passing: boolean;
  /** LLM suggestion for improvement (only for failing entries) */
  suggestion?: string;
}

export interface PostExtractAuditOptions {
  /** Minimum overall score to pass (default: 3) */
  threshold?: number;
  /** Batch size for LLM calls (default: 5) */
  batchSize?: number;
}

// ── LLM Prompt ───────────────────────────────────────────────────────────────

function buildAuditPrompt(entries: KnowledgeEntry[]): string {
  const combined = entries
    .map(
      (e, i) =>
        `[Entry ${i + 1}] (id: ${e.id}, type: ${e.type})\n标题: ${e.title}\n内容: ${e.content}`,
    )
    .join('\n\n---\n\n');

  return `你是一个知识质量审计专家。对以下新提取的知识条目进行三维度质量评估。

三个维度（每个 1-5 分）：
1. timeliness（时效性）：这条知识是否具有持久价值？纯时效性信息（如"今天的会议决定"）得低分，长期有效的原则/方法论得高分。
2. reusability（跨场景复用性）：这条知识能否在多个不同场景中被复用？只适用于单一特定场景的得低分，可广泛应用的得高分。
3. abstraction（抽象性）：这条知识是否足够抽象和通用？过于具体的操作细节得低分，提炼出的规律/原则得高分。

overall（总分）= 三个维度的平均值，四舍五入到整数。

对于总分 ≤ 2 的条目，必须生成 suggestion（改进建议）。

输出纯 JSON 数组，每条格式：
{
  "entry_id": "<id>",
  "timeliness": { "score": 1-5, "rationale": "理由" },
  "reusability": { "score": 1-5, "rationale": "理由" },
  "abstraction": { "score": 1-5, "rationale": "理由" },
  "overall": 1-5,
  "suggestion": "改进建议（仅低分条目需要）"
}

要求：
- 严格评分，不给人情分
- 中文输入产出中文评价
- 不要包含 markdown 代码块标记

知识条目：
${combined}`;
}

// ── Response Parsing ─────────────────────────────────────────────────────────

interface RawAuditItem {
  entry_id: string;
  timeliness: { score: number; rationale: string };
  reusability: { score: number; rationale: string };
  abstraction: { score: number; rationale: string };
  overall: number;
  suggestion?: string;
}

function parseAuditResponse(raw: string): RawAuditItem[] {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).entry_id === 'string',
    );
  } catch {
    return [];
  }
}

// ── Core Function ────────────────────────────────────────────────────────────

/**
 * Run post-extraction quality audit on newly extracted entries.
 * Returns audit results; entries that fail are marked for review.
 */
export async function runPostExtractAudit(
  entries: KnowledgeEntry[],
  options: PostExtractAuditOptions = {},
): Promise<AuditResult[]> {
  if (entries.length === 0) return [];

  const threshold = options.threshold ?? 3;
  const batchSize = options.batchSize ?? 5;

  const llmConfig = resolveLlmConfig();
  if ('error' in llmConfig) {
    throw new Error(`Post-extract audit failed: ${llmConfig.error}`);
  }

  const llm = new OpenAILLMProvider({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    timeoutMs: resolveLlmTimeoutMs(),
  });

  const results: AuditResult[] = [];

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const prompt = buildAuditPrompt(batch);

    let rawItems: RawAuditItem[] = [];
    try {
      const rawResponse = await llm.complete(prompt);
      rawItems = parseAuditResponse(rawResponse);
    } catch (err) {
      // On LLM failure, mark all entries in batch as pending_review (conservative)
      for (const entry of batch) {
        results.push({
          entryId: entry.id,
          title: entry.title,
          timeliness: { score: 0, rationale: 'LLM audit unavailable' },
          reusability: { score: 0, rationale: 'LLM audit unavailable' },
          abstraction: { score: 0, rationale: 'LLM audit unavailable' },
          overall: 0,
          passing: false,
          suggestion: `Audit failed due to LLM error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      continue;
    }

    // Map LLM results back to entries
    for (const entry of batch) {
      const item = rawItems.find((r) => r.entry_id === entry.id);
      if (item) {
        const overall = item.overall ?? Math.round(
          (item.timeliness.score + item.reusability.score + item.abstraction.score) / 3,
        );
        results.push({
          entryId: entry.id,
          title: entry.title,
          timeliness: item.timeliness,
          reusability: item.reusability,
          abstraction: item.abstraction,
          overall,
          passing: overall >= threshold,
          suggestion: item.suggestion,
        });
      } else {
        // Entry not in LLM response — conservative: mark as pending_review
        results.push({
          entryId: entry.id,
          title: entry.title,
          timeliness: { score: 0, rationale: 'Not evaluated by LLM' },
          reusability: { score: 0, rationale: 'Not evaluated by LLM' },
          abstraction: { score: 0, rationale: 'Not evaluated by LLM' },
          overall: 0,
          passing: false,
          suggestion: 'Entry was not evaluated — requires manual review',
        });
      }
    }
  }

  return results;
}

/**
 * Filter entries based on audit results.
 * Returns two arrays: entries that pass (ready for active use) and entries
 * that should be marked as pending_review.
 */
export function partitionByAudit(
  entries: KnowledgeEntry[],
  auditResults: AuditResult[],
): { approved: KnowledgeEntry[]; pendingReview: KnowledgeEntry[] } {
  const resultMap = new Map(auditResults.map((r) => [r.entryId, r]));
  const approved: KnowledgeEntry[] = [];
  const pendingReview: KnowledgeEntry[] = [];

  for (const entry of entries) {
    const result = resultMap.get(entry.id);
    if (result && result.passing) {
      approved.push(entry);
    } else {
      pendingReview.push(entry);
    }
  }

  return { approved, pendingReview };
}
