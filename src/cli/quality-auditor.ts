/**
 * Quality Auditor (FR-N03)
 *
 * Core logic for knowledge entry quality assessment and LLM-based rewriting.
 *
 * AC coverage:
 *   AC1: Three-dimension evaluation (specificity / actionability / contextualization)
 *   AC2: LLM quality scoring 1-5
 *   AC3: Score ≤ threshold → mark as failing, generate rewrite suggestion
 *   AC7: All quality assessment via LLM, zero keyword/regex
 */

import type Database from 'better-sqlite3';
import { OpenAILLMProvider, resolveLlmTimeoutMs } from '../extraction/llm-extractor.js';
import { resolveLlmConfig } from './resolve-llm-config.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface QualityScore {
  /** Overall score 1-5 */
  overall: number;
  /** Specificity: how specific and precise is the knowledge? */
  specificity: number;
  /** Actionability: can someone act on this knowledge directly? */
  actionability: number;
  /** Contextualization: is the scenario/context clearly defined? */
  contextualization: number;
  /** LLM-generated explanation of the scores */
  rationale: string;
  /** LLM-generated rewrite suggestion (only for low-scoring entries) */
  rewriteSuggestion?: string;
}

export interface QualityAssessment {
  entryId: string;
  title: string;
  type: string;
  domain: string | null;
  score: QualityScore;
  passing: boolean;
}

export interface QualityReport {
  totalEntries: number;
  assessed: number;
  passing: number;
  failing: number;
  passRate: number;
  scoreDistribution: Record<number, number>; // score → count
  top10Worst: QualityAssessment[];
  threshold: number;
}

export interface QualityGateStats {
  total: number;
  passed: number;
  rejected: number;
  merged: number;
  bypassed: number;
  rejectionReasons: Record<string, number>;
  rejectionRate: number;
  warning?: string;
}

export interface EntryForAudit {
  id: string;
  type: string;
  title: string;
  content: string;
  domain: string | null;
}

// ── LLM Quality Assessment ──────────────────────────────────────────────────

function buildQualityPrompt(entries: EntryForAudit[]): string {
  const combined = entries
    .map((e, i) => `[Entry ${i + 1}] (id: ${e.id}, type: ${e.type})\n标题: ${e.title}\n内容: ${e.content}`)
    .join('\n\n---\n\n');

  return `你是一个知识质量评估专家。对以下知识条目进行三维度质量评分。

三个维度（每个 1-5 分）：
1. specificity（具体性）：知识是否足够具体、精确？模糊的泛泛而谈得低分，有明确边界条件和细节的得高分。
2. actionability（可执行性）：读者能否直接根据这条知识采取行动？纯描述性的得低分，有明确操作步骤或判断标准的得高分。
3. contextualization（场景化）：知识的适用场景是否清晰？缺少上下文的得低分，明确说明"在什么情况下"的得高分。

overall（总分）= 三个维度的平均值，四舍五入到整数。

对于总分 ≤ 2 的条目，必须生成 rewrite_suggestion（改写建议），说明如何提升质量。

输出纯 JSON 数组，每条格式：
{
  "entry_id": "<id>",
  "specificity": 1-5,
  "actionability": 1-5,
  "contextualization": 1-5,
  "overall": 1-5,
  "rationale": "评分理由",
  "rewrite_suggestion": "改写建议（仅低分条目需要）"
}

要求：
- 严格评分，不要给人情分
- 中文输入产出中文评价
- 不要包含 markdown 代码块标记

知识条目：
${combined}`;
}

function buildRewritePrompt(entry: EntryForAudit, suggestion: string): string {
  return `你是一个知识改写专家。根据以下质量评估建议，改写这条知识条目，使其更具体、更可执行、更场景化。

原始条目：
标题: ${entry.title}
类型: ${entry.type}
内容: ${entry.content}

改写建议: ${suggestion}

要求：
- 保留原始知识的核心含义
- 提升具体性：加入明确的边界条件、参数、阈值
- 提升可执行性：加入操作步骤或判断标准
- 提升场景化：明确适用场景和前提条件
- 中文输出

输出纯 JSON 对象：
{
  "title": "改写后的简短标题（≤50字符）",
  "content": "改写后的内容",
  "summary": "一句话摘要"
}

不要包含 markdown 代码块标记。`;
}

interface RawScoreItem {
  entry_id: string;
  specificity: number;
  actionability: number;
  contextualization: number;
  overall: number;
  rationale: string;
  rewrite_suggestion?: string;
}

function parseQualityResponse(raw: string): RawScoreItem[] {
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

function parseRewriteResponse(raw: string): { title: string; content: string; summary: string } | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.content === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Assess quality of knowledge entries using LLM.
 * Processes in batches to stay within token limits.
 */
export async function assessQuality(
  entries: EntryForAudit[],
  threshold: number = 2,
): Promise<QualityAssessment[]> {
  if (entries.length === 0) return [];

  const llmConfig = resolveLlmConfig();
  if ('error' in llmConfig) {
    throw new Error(llmConfig.error);
  }

  const llm = new OpenAILLMProvider({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    timeoutMs: resolveLlmTimeoutMs(),
  });

  const results: QualityAssessment[] = [];
  const batchSize = 3;

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    if (i > 0) {
      await new Promise(r => setTimeout(r, 1500)); // rate limit + GC breathing room
    }

    const prompt = buildQualityPrompt(batch);
    const rawResponse = await llm.complete(prompt);
    const scores = parseQualityResponse(rawResponse);

    // Map scores back to entries
    const scoreMap = new Map(scores.map(s => [s.entry_id, s]));

    for (const entry of batch) {
      const score = scoreMap.get(entry.id);
      if (score) {
        const clamp = (v: number) => Math.max(1, Math.min(5, Math.round(v)));
        const qualityScore: QualityScore = {
          overall: clamp(score.overall),
          specificity: clamp(score.specificity),
          actionability: clamp(score.actionability),
          contextualization: clamp(score.contextualization),
          rationale: score.rationale || '',
          rewriteSuggestion: score.rewrite_suggestion,
        };

        results.push({
          entryId: entry.id,
          title: entry.title,
          type: entry.type,
          domain: entry.domain,
          score: qualityScore,
          passing: qualityScore.overall > threshold,
        });
      } else {
        // LLM didn't return a score for this entry — mark as needing review
        results.push({
          entryId: entry.id,
          title: entry.title,
          type: entry.type,
          domain: entry.domain,
          score: {
            overall: 0,
            specificity: 0,
            actionability: 0,
            contextualization: 0,
            rationale: 'LLM did not return a score for this entry',
          },
          passing: false,
        });
      }
    }
  }

  return results;
}

/**
 * Rewrite a single entry using LLM based on quality assessment suggestion.
 */
export async function rewriteEntry(
  entry: EntryForAudit,
  suggestion: string,
): Promise<{ title: string; content: string; summary: string } | null> {
  const llmConfig = resolveLlmConfig();
  if ('error' in llmConfig) {
    throw new Error(llmConfig.error);
  }

  const llm = new OpenAILLMProvider({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    timeoutMs: resolveLlmTimeoutMs(),
  });

  const prompt = buildRewritePrompt(entry, suggestion);
  const rawResponse = await llm.complete(prompt);
  return parseRewriteResponse(rawResponse);
}

/**
 * Build a quality report from assessment results.
 */
export function buildQualityReport(
  assessments: QualityAssessment[],
  totalEntries: number,
  threshold: number,
): QualityReport {
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let passing = 0;
  let failing = 0;

  for (const a of assessments) {
    const score = a.score.overall;
    if (score >= 1 && score <= 5) {
      distribution[score] = (distribution[score] || 0) + 1;
    }
    if (a.passing) passing++;
    else failing++;
  }

  const sorted = [...assessments].sort((a, b) => a.score.overall - b.score.overall);
  const top10Worst = sorted.slice(0, 10);

  return {
    totalEntries,
    assessed: assessments.length,
    passing,
    failing,
    passRate: assessments.length > 0 ? passing / assessments.length : 0,
    scoreDistribution: distribution,
    top10Worst,
    threshold,
  };
}

export function buildGateStatsFromQualityLog(
  db: Database.Database,
  sinceIso: string,
  rejectRateThreshold: number = 0.8,
): QualityGateStats {
  const rows = db.prepare(`
    SELECT decision, reason, COUNT(*) as count
    FROM quality_gate_log
    WHERE created_at >= ?
    GROUP BY decision, reason
  `).all(sinceIso) as Array<{ decision: string; reason: string; count: number }>;

  const stats: QualityGateStats = {
    total: 0,
    passed: 0,
    rejected: 0,
    merged: 0,
    bypassed: 0,
    rejectionReasons: {},
    rejectionRate: 0,
  };

  for (const row of rows) {
    const count = Number(row.count) || 0;
    stats.total += count;
    if (row.decision === 'passed') stats.passed += count;
    else if (row.decision === 'rejected') {
      stats.rejected += count;
      stats.rejectionReasons[row.reason] = (stats.rejectionReasons[row.reason] ?? 0) + count;
      if (row.reason === 'duplicate') stats.merged += count;
    } else if (row.decision === 'bypassed') {
      stats.bypassed += count;
    }
  }

  stats.rejectionRate = stats.total > 0 ? stats.rejected / stats.total : 0;
  if (stats.rejectionRate > rejectRateThreshold) {
    stats.warning = `质量门禁拒绝率 ${(stats.rejectionRate * 100).toFixed(1)}%，超过阈值 ${(rejectRateThreshold * 100).toFixed(0)}%，建议检查 session 筛选条件或萃取源质量。`;
  }
  return stats;
}

export interface PostExtractionQualityGovernanceOptions {
  db: Database.Database;
  sinceIso: string;
  threshold?: number;
  limit?: number;
}

export interface PostExtractionQualityGovernanceReport {
  assessed: number;
  quarantined: number;
  evidencePreserved: number;
  errors: string[];
}

/**
 * FR-N06: after cron/batch extraction, run LLM quality audit over newly written
 * entries and move low-quality entries to pending_review instead of deleting
 * them. The original content remains in entries and the assessment is copied
 * into quality_gate_log.candidate_json for later manual review.
 */
export async function runPostExtractionQualityGovernance(
  options: PostExtractionQualityGovernanceOptions,
): Promise<PostExtractionQualityGovernanceReport> {
  const threshold = options.threshold ?? 2;
  const limit = options.limit ?? 50;
  const rows = options.db.prepare(`
    SELECT id, type, title, content, domain
    FROM entries
    WHERE status = 'active'
      AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(options.sinceIso, limit) as EntryForAudit[];

  const report: PostExtractionQualityGovernanceReport = {
    assessed: 0,
    quarantined: 0,
    evidencePreserved: 0,
    errors: [],
  };

  if (rows.length === 0) return report;

  let assessments: QualityAssessment[];
  try {
    assessments = await assessQuality(rows, threshold);
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    return report;
  }

  report.assessed = assessments.length;
  const entriesById = new Map(rows.map(row => [row.id, row]));
  const updateStatus = options.db.prepare(`UPDATE entries SET status = 'pending_review', updated_at = ? WHERE id = ?`);
  const insertEvidence = options.db.prepare(`
    INSERT INTO quality_gate_log (
      entry_id, entry_title, source_reference, decision, reason, message,
      matched_entry_id, matched_entry_title, similarity, candidate_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  for (const assessment of assessments) {
    if (assessment.passing) continue;
    const entry = entriesById.get(assessment.entryId);
    if (!entry) continue;
    const update = updateStatus.run(now, entry.id);
    if (update.changes > 0) {
      report.quarantined += update.changes;
      const evidence = {
        entry,
        assessment,
        originalContent: entry.content,
      };
      const info = insertEvidence.run(
        entry.id,
        entry.title,
        'post-extraction-quality-governance',
        'rejected',
        'low_quality_quarantined',
        `批量萃取后质量审计未通过，已转入 pending_review。评分：${assessment.score.overall}/${threshold}。原因：${assessment.score.rationale}`,
        null,
        null,
        null,
        JSON.stringify(evidence),
        now,
      );
      report.evidencePreserved += info.changes;
    }
  }

  return report;
}

/**
 * Format a quality report as human-readable text.
 */
export function formatQualityReport(report: QualityReport): string {
  const lines: string[] = [];
  lines.push('═══ KIVO Knowledge Quality Report ═══\n');
  lines.push(`Total entries in DB: ${report.totalEntries}`);
  lines.push(`Assessed:            ${report.assessed}`);
  lines.push(`Passing (>${report.threshold}):     ${report.passing}`);
  lines.push(`Failing (≤${report.threshold}):     ${report.failing}`);
  lines.push(`Pass rate:           ${(report.passRate * 100).toFixed(1)}%\n`);

  lines.push('Score Distribution:');
  for (let s = 1; s <= 5; s++) {
    const count = report.scoreDistribution[s] || 0;
    const bar = '█'.repeat(Math.min(count, 40));
    lines.push(`  ${s} ★  ${bar} ${count}`);
  }

  if (report.top10Worst.length > 0) {
    lines.push('\nTop-10 Lowest Quality:');
    for (const a of report.top10Worst) {
      lines.push(`  [${a.score.overall}★] ${a.title} (${a.entryId.slice(0, 8)}) — ${a.score.rationale.slice(0, 80)}`);
    }
  }

  return lines.join('\n');
}
