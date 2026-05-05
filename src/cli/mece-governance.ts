/**
 * MECE Governance — 知识去重与覆盖度审计核心逻辑 (FR-N01)
 *
 * AC1: 入库前 BGE 向量语义查重
 * AC2: 全库语义去重扫描
 * AC3: 去重报告含合并建议
 * AC4: --auto 模式自动合并
 * AC5: 覆盖度审计
 * AC6: 语义相似度必须用 BGE 向量 embedding
 * AC7: --domain 按域限定扫描范围
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cosineSimilarity } from '../utils/math.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import { resolveLlmConfig } from './resolve-llm-config.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';
import type { DomainGoal } from '../domain-goal/domain-goal-types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DuplicatePair {
  entryA: { id: string; title: string; content: string; domain: string | null };
  entryB: { id: string; title: string; content: string; domain: string | null };
  similarity: number;
}

export interface MergeSuggestion {
  pair: DuplicatePair;
  keepId: string;
  removeId: string;
  strategy: 'keep_longer' | 'keep_newer' | 'merge_content';
  mergedContentPreview: string;
}

export interface DeduplicateReport {
  totalEntries: number;
  scannedEntries: number;
  duplicatePairs: DuplicatePair[];
  mergeSuggestions: MergeSuggestion[];
  autoMerged: number;
  domain?: string;
}

export interface CoverageGap {
  keyQuestion: string;
  covered: boolean;
  coveringEntryIds: string[];
  explanation: string;
}

export interface CoverageReport {
  domainId: string;
  purpose: string;
  totalQuestions: number;
  coveredQuestions: number;
  gaps: CoverageGap[];
}

interface EntryRow {
  id: string;
  title: string;
  content: string;
  domain: string | null;
  embedding: Buffer | null;
  created_at: string;
  updated_at: string;
  status: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveDbPath(): string {
  const dir = process.cwd();
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);
  if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }
  return resolve(dir, dbPath);
}

function bufferToVector(buf: Buffer): number[] {
  const float32 = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / 4,
  );
  return Array.from(float32);
}

function vectorToBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

// ── AC1: Pre-ingest dedup check ──────────────────────────────────────────────

export interface PreIngestCheckResult {
  isDuplicate: boolean;
  similarity: number;
  matchedEntryId?: string;
  matchedEntryTitle?: string;
  matchedEntryContent?: string;
}

/**
 * Check if a new entry's embedding is a near-duplicate of existing entries.
 * Returns the best match if similarity > threshold (default 0.80).
 */
export function checkPreIngestDuplicate(
  newVector: number[],
  dbPath?: string,
  threshold: number = 0.80,
): PreIngestCheckResult {
  const resolvedDb = dbPath ?? resolveDbPath();
  if (!existsSync(resolvedDb)) {
    return { isDuplicate: false, similarity: 0 };
  }

  const db = new Database(resolvedDb, { readonly: true });
  try {
    const rows = db.prepare(
      'SELECT id, title, content, embedding FROM entries WHERE embedding IS NOT NULL AND status = \'active\'',
    ).all() as Array<{ id: string; title: string; content: string; embedding: Buffer }>;

    let bestScore = 0;
    let bestRow: (typeof rows)[0] | null = null;

    for (const row of rows) {
      const vec = bufferToVector(row.embedding);
      const score = cosineSimilarity(newVector, vec);
      if (score > bestScore) {
        bestScore = score;
        bestRow = row;
      }
    }

    if (bestScore > threshold && bestRow) {
      return {
        isDuplicate: true,
        similarity: bestScore,
        matchedEntryId: bestRow.id,
        matchedEntryTitle: bestRow.title,
        matchedEntryContent: bestRow.content,
      };
    }

    return { isDuplicate: false, similarity: bestScore };
  } finally {
    db.close();
  }
}

// ── AC2/AC3/AC4/AC7: Full dedup scan ────────────────────────────────────────

export interface DeduplicateOptions {
  /** Similarity threshold for flagging duplicates (default 0.80) */
  threshold?: number;
  /** Auto-merge entries with similarity > 0.95 */
  auto?: boolean;
  /** Limit scan to a specific domain */
  domain?: string;
}

/**
 * Scan the entire knowledge base for semantic duplicates using BGE embeddings.
 * Returns a report with duplicate pairs and merge suggestions.
 */
export async function runDeduplicateScan(
  options: DeduplicateOptions = {},
): Promise<DeduplicateReport> {
  const { threshold = 0.80, auto = false, domain } = options;
  const autoMergeThreshold = 0.95;

  const resolvedDb = resolveDbPath();
  if (!existsSync(resolvedDb)) {
    throw new Error(`Database not found at ${resolvedDb}. Run \`kivo init\` first.`);
  }

  const db = new Database(resolvedDb);
  try {
    // Fetch entries with embeddings
    let query = 'SELECT id, title, content, domain, embedding, created_at, updated_at, status FROM entries WHERE embedding IS NOT NULL AND status = \'active\'';
    const params: string[] = [];
    if (domain) {
      query += ' AND (domain = ? OR knowledge_domain = ?)';
      params.push(domain, domain);
    }

    const rows = db.prepare(query).all(...params) as EntryRow[];
    const totalEntries = (db.prepare('SELECT COUNT(*) as cnt FROM entries WHERE status = \'active\'').get() as { cnt: number }).cnt;

    const duplicatePairs: DuplicatePair[] = [];

    // O(n^2) pairwise comparison — acceptable for <10k entries
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].embedding) continue;
      const vecA = bufferToVector(rows[i].embedding!);

      for (let j = i + 1; j < rows.length; j++) {
        if (!rows[j].embedding) continue;
        const vecB = bufferToVector(rows[j].embedding!);

        const sim = cosineSimilarity(vecA, vecB);
        if (sim > threshold) {
          duplicatePairs.push({
            entryA: { id: rows[i].id, title: rows[i].title, content: rows[i].content, domain: rows[i].domain },
            entryB: { id: rows[j].id, title: rows[j].title, content: rows[j].content, domain: rows[j].domain },
            similarity: sim,
          });
        }
      }
    }

    // Sort by similarity descending
    duplicatePairs.sort((a, b) => b.similarity - a.similarity);

    // Generate merge suggestions
    const mergeSuggestions: MergeSuggestion[] = [];
    for (const pair of duplicatePairs) {
      const rowA = rows.find(r => r.id === pair.entryA.id)!;
      const rowB = rows.find(r => r.id === pair.entryB.id)!;

      // Strategy: keep the longer content entry, or the newer one if similar length
      let keepId: string;
      let removeId: string;
      let strategy: MergeSuggestion['strategy'];

      const lenDiff = Math.abs(pair.entryA.content.length - pair.entryB.content.length);
      if (lenDiff > pair.entryA.content.length * 0.2) {
        // Significant length difference — keep longer
        if (pair.entryA.content.length >= pair.entryB.content.length) {
          keepId = pair.entryA.id;
          removeId = pair.entryB.id;
        } else {
          keepId = pair.entryB.id;
          removeId = pair.entryA.id;
        }
        strategy = 'keep_longer';
      } else {
        // Similar length — keep newer
        const dateA = new Date(rowA.updated_at).getTime();
        const dateB = new Date(rowB.updated_at).getTime();
        if (dateA >= dateB) {
          keepId = pair.entryA.id;
          removeId = pair.entryB.id;
        } else {
          keepId = pair.entryB.id;
          removeId = pair.entryA.id;
        }
        strategy = 'keep_newer';
      }

      // Merged content preview: the kept entry's content
      const keepEntry = keepId === pair.entryA.id ? pair.entryA : pair.entryB;
      const mergedContentPreview = keepEntry.content.slice(0, 300) +
        (keepEntry.content.length > 300 ? '...' : '');

      mergeSuggestions.push({
        pair,
        keepId,
        removeId,
        strategy,
        mergedContentPreview,
      });
    }

    // AC4: Auto-merge if --auto and similarity > 0.95
    let autoMerged = 0;
    if (auto) {
      const now = new Date().toISOString();
      // Create backup table for rollback
      db.exec(`CREATE TABLE IF NOT EXISTS mece_merge_log (
        id TEXT PRIMARY KEY,
        merged_at TEXT NOT NULL,
        keep_id TEXT NOT NULL,
        remove_id TEXT NOT NULL,
        similarity REAL NOT NULL,
        removed_entry_json TEXT NOT NULL
      )`);

      for (const suggestion of mergeSuggestions) {
        if (suggestion.pair.similarity > autoMergeThreshold) {
          // Backup the entry to be removed
          const removedRow = db.prepare('SELECT * FROM entries WHERE id = ?').get(suggestion.removeId);
          if (removedRow) {
            const logId = randomUUID();
            db.prepare(
              'INSERT INTO mece_merge_log (id, merged_at, keep_id, remove_id, similarity, removed_entry_json) VALUES (?, ?, ?, ?, ?, ?)',
            ).run(logId, now, suggestion.keepId, suggestion.removeId, suggestion.pair.similarity, JSON.stringify(removedRow));

            // Soft-delete the duplicate
            db.prepare('UPDATE entries SET status = \'superseded\' WHERE id = ?').run(suggestion.removeId);
            autoMerged++;
          }
        }
      }
    }

    return {
      totalEntries,
      scannedEntries: rows.length,
      duplicatePairs,
      mergeSuggestions,
      autoMerged,
      domain,
    };
  } finally {
    db.close();
  }
}

// ── AC5: Coverage audit ──────────────────────────────────────────────────────

export interface CoverageAuditOptions {
  domain: string;
}

/**
 * Audit knowledge coverage against a domain's keyQuestions.
 * Uses LLM to judge whether each keyQuestion is covered by existing entries.
 */
export async function runCoverageAudit(
  options: CoverageAuditOptions,
): Promise<CoverageReport> {
  const { domain } = options;
  const resolvedDb = resolveDbPath();
  if (!existsSync(resolvedDb)) {
    throw new Error(`Database not found at ${resolvedDb}. Run \`kivo init\` first.`);
  }

  const db = new Database(resolvedDb, { readonly: true });

  // Load domain goal
  const goalRow = db.prepare('SELECT * FROM domain_goals WHERE domain_id = ?').get(domain) as {
    domain_id: string;
    purpose: string;
    key_questions: string;
    non_goals: string;
    research_boundary: string;
    priority_signals: string;
  } | undefined;

  if (!goalRow) {
    db.close();
    throw new Error(`Domain goal not found for "${domain}". Create one first with domain-goal management.`);
  }

  const keyQuestions: string[] = JSON.parse(goalRow.key_questions || '[]');
  if (keyQuestions.length === 0) {
    db.close();
    return {
      domainId: domain,
      purpose: goalRow.purpose,
      totalQuestions: 0,
      coveredQuestions: 0,
      gaps: [],
    };
  }

  // Load entries for this domain
  const entries = db.prepare(
    'SELECT id, title, content FROM entries WHERE (domain = ? OR knowledge_domain = ?) AND status = \'active\'',
  ).all(domain, domain) as Array<{ id: string; title: string; content: string }>;
  db.close();

  // Use LLM to judge coverage
  const llmConfig = resolveLlmConfig();
  if ('error' in llmConfig) {
    throw new Error(llmConfig.error);
  }

  const llm = new OpenAILLMProvider({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    timeoutMs: 120_000,
  });

  // Build a summary of existing knowledge
  const knowledgeSummary = entries
    .map(e => `[${e.id.slice(0, 8)}] ${e.title}: ${e.content.slice(0, 200)}`)
    .join('\n');

  const prompt = `你是知识覆盖度审计员。给定一个知识域的关键问题列表和现有知识条目，判断每个关键问题是否被现有知识覆盖。

知识域: ${domain}
目标: ${goalRow.purpose}

关键问题:
${keyQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

现有知识条目（共 ${entries.length} 条）:
${knowledgeSummary || '（无条目）'}

对每个关键问题，判断：
1. 是否被现有知识覆盖（covered: true/false）
2. 覆盖该问题的条目 ID 列表（取 id 前 8 位即可）
3. 简短说明覆盖情况或缺失原因

输出纯 JSON 数组：
[{"question":"问题内容","covered":true/false,"coveringIds":["id前8位"],"explanation":"说明"}]`;

  const rawResponse = await llm.complete(prompt);
  let parsed: Array<{
    question: string;
    covered: boolean;
    coveringIds: string[];
    explanation: string;
  }>;

  try {
    let cleaned = rawResponse.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) parsed = [];
  } catch {
    parsed = [];
  }

  // Map back to CoverageGap format
  const gaps: CoverageGap[] = keyQuestions.map((q, i) => {
    const match = parsed[i] ?? parsed.find(p => p.question === q);
    if (match) {
      // Resolve short IDs to full IDs
      const fullIds = (match.coveringIds ?? []).map(shortId => {
        const found = entries.find(e => e.id.startsWith(shortId));
        return found?.id ?? shortId;
      });
      return {
        keyQuestion: q,
        covered: !!match.covered,
        coveringEntryIds: fullIds,
        explanation: match.explanation ?? '',
      };
    }
    return {
      keyQuestion: q,
      covered: false,
      coveringEntryIds: [],
      explanation: 'LLM 未返回该问题的评估结果',
    };
  });

  return {
    domainId: domain,
    purpose: goalRow.purpose,
    totalQuestions: keyQuestions.length,
    coveredQuestions: gaps.filter(g => g.covered).length,
    gaps,
  };
}

// ── Report formatting ────────────────────────────────────────────────────────

/**
 * checkDuplicate — convenience wrapper for cmd-learn-from-badcase (FR-N02 AC6).
 * Embeds the content with BGE and checks against existing entries.
 */
export async function checkDuplicate(
  content: string,
  options: { cwd?: string } = {},
): Promise<{ isDuplicate: boolean; matchId?: string; similarity?: number }> {
  const dir = options.cwd ?? process.cwd();
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);
  if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }
  const resolvedDb = resolve(dir, dbPath);

  if (!existsSync(resolvedDb)) {
    return { isDuplicate: false };
  }

  // Lazy-import to avoid circular deps
  const { BgeEmbedder } = await import('../extraction/bge-embedder.js');
  if (!BgeEmbedder.isAvailable()) {
    return { isDuplicate: false };
  }

  const embedder = new BgeEmbedder();
  try {
    const vector = await embedder.embed(content);
    const result = checkPreIngestDuplicate(vector, resolvedDb, 0.80);
    return {
      isDuplicate: result.isDuplicate,
      matchId: result.matchedEntryId,
      similarity: result.similarity,
    };
  } finally {
    await embedder.close();
  }
}

export function formatDeduplicateReport(report: DeduplicateReport): string {
  const lines: string[] = [];
  lines.push('═══ KIVO MECE 去重报告 ═══');
  lines.push('');
  if (report.domain) {
    lines.push(`域: ${report.domain}`);
  }
  lines.push(`总条目: ${report.totalEntries}`);
  lines.push(`已扫描（有向量）: ${report.scannedEntries}`);
  lines.push(`发现重复对: ${report.duplicatePairs.length}`);
  if (report.autoMerged > 0) {
    lines.push(`自动合并: ${report.autoMerged} 条（可通过 mece_merge_log 表回退）`);
  }
  lines.push('');

  if (report.mergeSuggestions.length === 0) {
    lines.push('✓ 未发现语义重复条目');
    return lines.join('\n');
  }

  lines.push('── 合并建议 ──');
  for (const s of report.mergeSuggestions) {
    lines.push('');
    lines.push(`相似度: ${(s.pair.similarity * 100).toFixed(1)}%`);
    lines.push(`  A: [${s.pair.entryA.id.slice(0, 8)}] ${s.pair.entryA.title}`);
    lines.push(`  B: [${s.pair.entryB.id.slice(0, 8)}] ${s.pair.entryB.title}`);
    lines.push(`  策略: ${s.strategy === 'keep_longer' ? '保留较长条目' : s.strategy === 'keep_newer' ? '保留较新条目' : '合并内容'}`);
    lines.push(`  保留: ${s.keepId.slice(0, 8)} | 移除: ${s.removeId.slice(0, 8)}`);
    lines.push(`  预览: ${s.mergedContentPreview.slice(0, 120)}...`);
  }

  return lines.join('\n');
}

export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push('═══ KIVO 覆盖度审计报告 ═══');
  lines.push('');
  lines.push(`域: ${report.domainId}`);
  lines.push(`目标: ${report.purpose}`);
  lines.push(`覆盖率: ${report.coveredQuestions}/${report.totalQuestions} (${report.totalQuestions > 0 ? ((report.coveredQuestions / report.totalQuestions) * 100).toFixed(0) : 0}%)`);
  lines.push('');

  if (report.gaps.length === 0) {
    lines.push('✓ 无关键问题需要审计');
    return lines.join('\n');
  }

  lines.push('── 关键问题覆盖详情 ──');
  for (const gap of report.gaps) {
    const icon = gap.covered ? '✓' : '✗';
    lines.push(`  ${icon} ${gap.keyQuestion}`);
    if (gap.coveringEntryIds.length > 0) {
      lines.push(`    覆盖条目: ${gap.coveringEntryIds.map(id => id.slice(0, 8)).join(', ')}`);
    }
    lines.push(`    ${gap.explanation}`);
  }

  const uncovered = report.gaps.filter(g => !g.covered);
  if (uncovered.length > 0) {
    lines.push('');
    lines.push(`⚠ ${uncovered.length} 个关键问题未覆盖，建议补充相关知识`);
  }

  return lines.join('\n');
}
