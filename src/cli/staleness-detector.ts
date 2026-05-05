/**
 * Staleness Detector — 存量知识过时检测
 *
 * 逻辑：
 * 1. 查找 updated_at 距今超过 N 天的 active 条目
 * 2. 分批用 LLM 判断内容是否仍然准确/相关
 * 3. 过时条目标记为 archived
 * 4. 写入 quality_gate_log 审计轨迹
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DEFAULT_CONFIG } from '../config/types.js';
import { resolveLlmConfig } from './resolve-llm-config.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface StalenessOptions {
  batchSize?: number;
  maxAgeDays?: number;
  dryRun?: boolean;
  json?: boolean;
  domain?: string;
}

export interface StalenessResult {
  entryId: string;
  title: string;
  type: string;
  updatedAt: string;
  ageDays: number;
  isStale: boolean;
  reasoning: string;
}

export interface StalenessReport {
  runAt: string;
  totalCandidates: number;
  assessed: number;
  staleCount: number;
  archivedCount: number;
  dryRun: boolean;
  maxAgeDays: number;
  results: StalenessResult[];
}

interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  domain: string | null;
  status: string;
  updated_at: string;
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

function logStalenessAction(
  db: Database.Database,
  entryId: string,
  entryTitle: string,
  reasoning: string,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO quality_gate_log (
      entry_id, entry_title, source_reference, decision, reason, message,
      matched_entry_id, matched_entry_title, similarity, candidate_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
  `).run(
    entryId,
    entryTitle,
    'staleness-detector',
    'staleness_archived',
    'content_outdated',
    reasoning,
    JSON.stringify({ action: 'staleness_archived', reasoning }),
    now,
  );
}

// ── LLM Staleness Assessment ─────────────────────────────────────────────────

function buildStalenessPrompt(entries: EntryRow[]): string {
  const combined = entries
    .map((e, i) => `[Entry ${i + 1}] (id: ${e.id}, type: ${e.type}, last_updated: ${e.updated_at})\n标题: ${e.title}\n内容: ${e.content.slice(0, 1000)}`)
    .join('\n\n---\n\n');

  return `你是一个知识时效性评估专家。判断以下知识条目在当前时间点是否仍然准确和相关。

判断标准：
1. 内容是否包含已过时的事实（如已废弃的 API、已变更的政策、已过时的技术方案）？
2. 内容描述的场景/工具/方法是否仍然是当前最佳实践？
3. 内容中的数据/数字/版本号是否仍然准确？

注意：
- 通用原则、方法论、思维模型通常不会过时
- 具体技术实现、API 用法、配置参数容易过时
- 如果无法确定是否过时，判定为 NOT stale（保守策略）

输出纯 JSON 数组，每条格式：
{
  "entry_id": "<id>",
  "is_stale": true/false,
  "reasoning": "一句话理由"
}

不要包含 markdown 代码块标记。

知识条目：
${combined}`;
}

interface RawStalenessItem {
  entry_id: string;
  is_stale: boolean;
  reasoning: string;
}

function parseStalenessResponse(raw: string): RawStalenessItem[] {
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

// ── Main ─────────────────────────────────────────────────────────────────────

export async function runStalenessCheck(options: StalenessOptions = {}): Promise<StalenessReport> {
  const batchSize = options.batchSize ?? 20;
  const maxAgeDays = options.maxAgeDays ?? 90;
  const dryRun = options.dryRun ?? false;

  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}. Run \`kivo init\` first.`);
  }

  const llmConfig = resolveLlmConfig();
  if ('error' in llmConfig) {
    throw new Error(`LLM unavailable: ${llmConfig.error}. Staleness detection requires LLM.`);
  }

  const llm = new OpenAILLMProvider({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    timeoutMs: 120_000,
  });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  try {
    // Ensure quality_gate_log table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS quality_gate_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT,
        entry_title TEXT NOT NULL,
        source_reference TEXT,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        message TEXT NOT NULL,
        matched_entry_id TEXT,
        matched_entry_title TEXT,
        similarity REAL,
        candidate_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    // Find entries older than maxAgeDays
    const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

    let query = `SELECT id, type, title, content, domain, status, updated_at
                 FROM entries
                 WHERE status = 'active' AND updated_at < ?`;
    const params: string[] = [cutoffDate];

    if (options.domain) {
      query += ' AND (domain = ? OR knowledge_domain = ?)';
      params.push(options.domain, options.domain);
    }

    query += ' ORDER BY updated_at ASC';

    const candidates = db.prepare(query).all(...params) as EntryRow[];
    const now = Date.now();

    const report: StalenessReport = {
      runAt: new Date().toISOString(),
      totalCandidates: candidates.length,
      assessed: 0,
      staleCount: 0,
      archivedCount: 0,
      dryRun,
      maxAgeDays,
      results: [],
    };

    if (candidates.length === 0) {
      return report;
    }

    // Process in batches
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);

      if (i > 0) {
        // Rate limit between batches
        await new Promise(r => setTimeout(r, 2000));
      }

      const prompt = buildStalenessPrompt(batch);

      try {
        const rawResponse = await llm.complete(prompt);
        const items = parseStalenessResponse(rawResponse);
        const itemMap = new Map(items.map(item => [item.entry_id, item]));

        for (const entry of batch) {
          const item = itemMap.get(entry.id);
          const ageDays = Math.floor((now - new Date(entry.updated_at).getTime()) / (24 * 60 * 60 * 1000));

          if (item) {
            const result: StalenessResult = {
              entryId: entry.id,
              title: entry.title,
              type: entry.type,
              updatedAt: entry.updated_at,
              ageDays,
              isStale: item.is_stale,
              reasoning: item.reasoning || '',
            };
            report.results.push(result);
            report.assessed++;

            if (item.is_stale) {
              report.staleCount++;

              if (!dryRun) {
                db.prepare('UPDATE entries SET status = ?, updated_at = ? WHERE id = ?')
                  .run('archived', new Date().toISOString(), entry.id);
                logStalenessAction(db, entry.id, entry.title, item.reasoning || 'Content outdated');
                report.archivedCount++;
              }
            }
          } else {
            // LLM didn't return result for this entry — skip (conservative)
            report.results.push({
              entryId: entry.id,
              title: entry.title,
              type: entry.type,
              updatedAt: entry.updated_at,
              ageDays,
              isStale: false,
              reasoning: 'LLM did not return assessment — skipped (conservative)',
            });
            report.assessed++;
          }
        }
      } catch (error) {
        // Batch failed — mark all as skipped
        for (const entry of batch) {
          const ageDays = Math.floor((now - new Date(entry.updated_at).getTime()) / (24 * 60 * 60 * 1000));
          report.results.push({
            entryId: entry.id,
            title: entry.title,
            type: entry.type,
            updatedAt: entry.updated_at,
            ageDays,
            isStale: false,
            reasoning: `LLM batch failed: ${(error as Error).message}`,
          });
          report.assessed++;
        }
      }
    }

    return report;
  } finally {
    db.close();
  }
}

// ── Report Formatting ────────────────────────────────────────────────────────

export function formatStalenessReport(report: StalenessReport): string {
  const lines: string[] = [];
  lines.push('═══ KIVO 知识过时检测报告 ═══');
  lines.push('');
  lines.push(`执行时间: ${report.runAt}`);
  lines.push(`模式: ${report.dryRun ? '预览（dry-run）' : '执行'}`);
  lines.push(`过时阈值: ${report.maxAgeDays} 天未更新`);
  lines.push('');
  lines.push(`候选条目: ${report.totalCandidates}`);
  lines.push(`已评估: ${report.assessed}`);
  lines.push(`判定过时: ${report.staleCount}`);
  lines.push(`已归档: ${report.archivedCount}`);
  lines.push('');

  const staleResults = report.results.filter(r => r.isStale);
  if (staleResults.length > 0) {
    lines.push('── 过时条目 ──');
    for (const r of staleResults) {
      lines.push(`  ⚠ [${r.entryId.slice(0, 8)}] ${r.title}`);
      lines.push(`    类型: ${r.type} | 年龄: ${r.ageDays}天 | 理由: ${r.reasoning}`);
    }
    lines.push('');
  }

  if (report.staleCount === 0 && report.totalCandidates > 0) {
    lines.push('✓ 所有候选条目仍然有效，无需归档');
  } else if (report.totalCandidates === 0) {
    lines.push('✓ 没有超过阈值的条目，知识库很新鲜');
  }

  return lines.join('\n');
}
