/**
 * Periodic Governance — 知识库定期治理 (FR-N08)
 *
 * 功能：
 * 1. 过时检测：对 fact 类型条目，用 LLM 判断是否仍成立
 * 2. 价值衰减：last_hit_at 超过 N 天（可配置，默认 90）的条目 confidence -= 0.1，低于阈值（可配置，默认 0.3）则 archived
 * 3. 矛盾扫描：BGE embedding 余弦预筛（cosine > 0.6）→ LLM 精判，结果进入冲突裁决队列
 * 4. 常识回收：用 LLM 评估条目是否已被模型内化
 * 5. 审计轨迹：写入 quality_gate_log 表
 * 6. 恢复命令：governance restore <id>
 * 7. 报告输出：Top-10 高风险条目
 * 8. 运行摘要持久化：每次 governance run 写入 quality_gate_log（decision='governance_summary'）
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DEFAULT_CONFIG } from '../config/types.js';
import { resolveLlmConfig } from './resolve-llm-config.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';
import { cosineSimilarity } from '../utils/math.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PeriodicGovernanceOptions {
  domain?: string;
  dryRun?: boolean;
  json?: boolean;
  decayDays?: number;
  minConfidence?: number;
}

export interface GovernanceAction {
  entryId: string;
  entryTitle: string;
  actionType: 'staleness_archived' | 'value_decay' | 'value_archived' | 'common_reclaimed' | 'contradiction_flagged';
  reason: string;
  previousConfidence: number;
  newConfidence: number;
  previousStatus: string;
  newStatus: string;
}

export interface PeriodicGovernanceReport {
  runAt: string;
  totalScanned: number;
  actions: GovernanceAction[];
  topRiskEntries: Array<{ id: string; title: string; confidence: number; status: string }>;
  contradictions: Array<{ entryAId: string; entryATitle: string; entryBId: string; entryBTitle: string }>;
  dryRun: boolean;
}

interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  domain: string | null;
  knowledge_domain: string | null;
  confidence: number;
  status: string;
  updated_at: string;
  last_hit_at: string | null;
  embedding: Buffer | null;
}

/** Read governance config from kivo.config.json */
function resolveGovernanceConfig(): { decayDays: number; minConfidence: number; contradictionThreshold: number } {
  const defaults = { decayDays: 90, minConfidence: 0.3, contradictionThreshold: 0.6 };
  const dir = process.cwd();
  const configPath = join(dir, 'kivo.config.json');
  if (!existsSync(configPath)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const gov = raw.governance ?? {};
    return {
      decayDays: typeof gov.decayDays === 'number' ? gov.decayDays : defaults.decayDays,
      minConfidence: typeof gov.minConfidence === 'number' ? gov.minConfidence : defaults.minConfidence,
      contradictionThreshold: typeof gov.contradictionThreshold === 'number' ? gov.contradictionThreshold : defaults.contradictionThreshold,
    };
  } catch {
    return defaults;
  }
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

function getLlmProvider(): OpenAILLMProvider | null {
  const config = resolveLlmConfig();
  if ('error' in config) {
    console.warn(`[KIVO Governance] LLM 不可用: ${config.error}`);
    return null;
  }
  return new OpenAILLMProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });
}

function logGovernanceAction(
  db: Database.Database,
  entryId: string,
  entryTitle: string,
  decision: string,
  reason: string,
  message: string,
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
    'periodic-governance',
    decision,
    reason,
    message,
    JSON.stringify({ action: decision, reason }),
    now,
  );
}

// ── Staleness Detection ──────────────────────────────────────────────────────

async function detectStaleness(
  llm: OpenAILLMProvider,
  entries: EntryRow[],
  dryRun: boolean,
  db: Database.Database,
): Promise<GovernanceAction[]> {
  const factEntries = entries.filter(e => e.type === 'fact');
  const actions: GovernanceAction[] = [];

  for (const entry of factEntries) {
    const prompt = `你是一个知识时效性评估引擎。判断以下事实在当前时间点是否仍然准确。

事实标题：${entry.title}
事实内容：${entry.content.slice(0, 1500)}

请回答纯 JSON：
{"still_valid": true/false, "reasoning": "一句话理由"}
不要包含 markdown 代码块标记。`;

    try {
      const raw = await llm.complete(prompt);
      const result = JSON.parse(raw.replace(/```json?\s*|\s*```/g, '').trim());

      if (result.still_valid === false) {
        const action: GovernanceAction = {
          entryId: entry.id,
          entryTitle: entry.title,
          actionType: 'staleness_archived',
          reason: result.reasoning || '事实已过时',
          previousConfidence: entry.confidence,
          newConfidence: entry.confidence,
          previousStatus: entry.status,
          newStatus: 'deprecated',
        };
        actions.push(action);

        if (!dryRun) {
          db.prepare('UPDATE entries SET status = ?, updated_at = ? WHERE id = ?')
            .run('deprecated', new Date().toISOString(), entry.id);
          logGovernanceAction(db, entry.id, entry.title, 'governance_staleness', 'stale_fact', result.reasoning || '事实已过时');
        }
      }
    } catch {
      // LLM call failed for this entry, skip
    }
  }

  return actions;
}

// ── Value Decay ──────────────────────────────────────────────────────────────

function applyValueDecay(
  entries: EntryRow[],
  dryRun: boolean,
  db: Database.Database,
  options?: { decayDays?: number; minConfidence?: number },
): GovernanceAction[] {
  const actions: GovernanceAction[] = [];
  const now = Date.now();
  const decayDays = options?.decayDays ?? 90;
  const minConfidence = options?.minConfidence ?? 0.3;
  const decayMs = decayDays * 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    // P0-2: Use last_hit_at (last retrieval hit time) instead of updated_at.
    // Fallback to updated_at only when last_hit_at is NULL (historical data without hit tracking).
    const referenceTime = entry.last_hit_at
      ? new Date(entry.last_hit_at).getTime()
      : new Date(entry.updated_at).getTime();
    if (now - referenceTime <= decayMs) continue;

    const newConfidence = Math.round((entry.confidence - 0.1) * 100) / 100;
    const newStatus = newConfidence < minConfidence ? 'archived' : entry.status;
    const actionType = newConfidence < minConfidence ? 'value_archived' : 'value_decay';

    const timeSource = entry.last_hit_at ? 'last_hit_at' : 'updated_at(fallback)';
    const action: GovernanceAction = {
      entryId: entry.id,
      entryTitle: entry.title,
      actionType,
      reason: `${decayDays}天未访问(${timeSource})，confidence ${entry.confidence} → ${newConfidence}${newConfidence < minConfidence ? '，已归档' : ''}`,
      previousConfidence: entry.confidence,
      newConfidence: Math.max(0, newConfidence),
      previousStatus: entry.status,
      newStatus,
    };
    actions.push(action);

    if (!dryRun) {
      db.prepare('UPDATE entries SET confidence = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(Math.max(0, newConfidence), newStatus, new Date().toISOString(), entry.id);
      logGovernanceAction(
        db, entry.id, entry.title,
        `governance_${actionType}`,
        'value_decay',
        action.reason,
      );
    }
  }

  return actions;
}

// ── Contradiction Scan (P0-1: BGE embedding pre-filter + LLM judge) ──────────

/** Decode embedding buffer (stored as Float32Array binary) to number[] */
function decodeEmbedding(buf: Buffer | null): number[] | null {
  if (!buf || buf.length === 0) return null;
  const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(floats);
}

async function scanContradictions(
  llm: OpenAILLMProvider,
  entries: EntryRow[],
  dryRun: boolean,
  db: Database.Database,
  options?: { contradictionThreshold?: number },
): Promise<{ actions: GovernanceAction[]; contradictions: PeriodicGovernanceReport['contradictions'] }> {
  const actions: GovernanceAction[] = [];
  const contradictions: PeriodicGovernanceReport['contradictions'] = [];
  const BATCH_SIZE = 500;
  const SIMILARITY_THRESHOLD = options?.contradictionThreshold ?? 0.6;

  // Group by domain
  const domainGroups = new Map<string, EntryRow[]>();
  for (const entry of entries) {
    const domain = entry.domain || entry.knowledge_domain || '_default';
    if (!domainGroups.has(domain)) domainGroups.set(domain, []);
    domainGroups.get(domain)!.push(entry);
  }

  for (const [, group] of domainGroups) {
    // Process in batches of 500
    for (let i = 0; i < group.length; i += BATCH_SIZE) {
      const batch = group.slice(i, i + BATCH_SIZE);
      if (batch.length < 2) continue;

      // P0-1: BGE embedding cosine pre-filter — only pairs with cosine > threshold go to LLM
      const pairs: Array<[EntryRow, EntryRow]> = [];

      // Pre-decode embeddings for the batch
      const embeddings = batch.map(e => decodeEmbedding(e.embedding));

      for (let a = 0; a < batch.length; a++) {
        for (let b = a + 1; b < batch.length; b++) {
          // Only check entries of the same type for contradictions
          if (batch[a].type !== batch[b].type) continue;

          const vecA = embeddings[a];
          const vecB = embeddings[b];

          if (vecA && vecB) {
            // Use embedding cosine similarity as pre-filter
            const similarity = cosineSimilarity(vecA, vecB);
            if (similarity >= SIMILARITY_THRESHOLD) {
              pairs.push([batch[a], batch[b]]);
            }
          }
          // If either entry lacks embedding, skip (cannot pre-filter without vectors)
        }
      }

      for (const [entryA, entryB] of pairs) {
        const prompt = `你是一个知识一致性检测引擎。判断以下两条知识是否存在矛盾。

条目A：
标题：${entryA.title}
内容：${entryA.content.slice(0, 800)}

条目B：
标题：${entryB.title}
内容：${entryB.content.slice(0, 800)}

请回答纯 JSON：
{"contradicts": true/false, "reasoning": "一句话理由"}
不要包含 markdown 代码块标记。`;

        try {
          const raw = await llm.complete(prompt);
          const result = JSON.parse(raw.replace(/```json?\s*|\s*```/g, '').trim());

          if (result.contradicts === true) {
            contradictions.push({
              entryAId: entryA.id,
              entryATitle: entryA.title,
              entryBId: entryB.id,
              entryBTitle: entryB.title,
            });

            const action: GovernanceAction = {
              entryId: entryA.id,
              entryTitle: entryA.title,
              actionType: 'contradiction_flagged',
              reason: `与 [${entryB.id.slice(0, 8)}] "${entryB.title}" 矛盾: ${result.reasoning || ''}`,
              previousConfidence: entryA.confidence,
              newConfidence: entryA.confidence,
              previousStatus: entryA.status,
              newStatus: entryA.status,
            };
            actions.push(action);

            // P1-1: Write contradiction into conflict resolution queue (quality_gate_log)
            if (!dryRun) {
              logGovernanceAction(
                db, entryA.id, entryA.title,
                'governance_conflict',
                'contradiction_detected',
                `与 [${entryB.id.slice(0, 8)}] "${entryB.title}" 矛盾: ${result.reasoning || ''}`,
              );
              // Also log for entryB so both sides are in the queue
              logGovernanceAction(
                db, entryB.id, entryB.title,
                'governance_conflict',
                'contradiction_detected',
                `与 [${entryA.id.slice(0, 8)}] "${entryA.title}" 矛盾: ${result.reasoning || ''}`,
              );
            }
          }
        } catch {
          // LLM call failed, skip this pair
        }
      }
    }
  }

  return { actions, contradictions };
}

// ── Common Knowledge Reclaim ─────────────────────────────────────────────────

async function reclaimCommonKnowledge(
  llm: OpenAILLMProvider,
  entries: EntryRow[],
  dryRun: boolean,
  db: Database.Database,
): Promise<GovernanceAction[]> {
  const actions: GovernanceAction[] = [];

  for (const entry of entries) {
    const prompt = `你是一个知识价值评估引擎。判断以下知识是否已被通用 LLM 内化——即一个通用 LLM 不需要这条知识也能正确回答相关问题。

知识标题：${entry.title}
知识内容：${entry.content.slice(0, 1500)}
知识类型：${entry.type}

请回答纯 JSON：
{"internalized": true/false, "reasoning": "一句话理由"}
不要包含 markdown 代码块标记。`;

    try {
      const raw = await llm.complete(prompt);
      const result = JSON.parse(raw.replace(/```json?\s*|\s*```/g, '').trim());

      if (result.internalized === true) {
        const action: GovernanceAction = {
          entryId: entry.id,
          entryTitle: entry.title,
          actionType: 'common_reclaimed',
          reason: result.reasoning || 'LLM 已内化此知识',
          previousConfidence: entry.confidence,
          newConfidence: entry.confidence,
          previousStatus: entry.status,
          newStatus: 'archived',
        };
        actions.push(action);

        if (!dryRun) {
          db.prepare('UPDATE entries SET status = ?, updated_at = ? WHERE id = ?')
            .run('archived', new Date().toISOString(), entry.id);
          logGovernanceAction(
            db, entry.id, entry.title,
            'governance_common_reclaim',
            'llm_internalized',
            result.reasoning || 'LLM 已内化此知识',
          );
        }
      }
    } catch {
      // LLM call failed, skip
    }
  }

  return actions;
}

// ── Main Run ─────────────────────────────────────────────────────────────────

export async function runPeriodicGovernance(options: PeriodicGovernanceOptions = {}): Promise<PeriodicGovernanceReport> {
  const { domain, dryRun = false } = options;

  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}. Run \`kivo init\` first.`);
  }

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

    // P0-2: Ensure last_hit_at column exists (migration for historical DBs)
    const colInfo = db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>;
    const colNames = new Set(colInfo.map(c => c.name));
    if (!colNames.has('last_hit_at')) {
      db.exec('ALTER TABLE entries ADD COLUMN last_hit_at TEXT');
    }

    // P1-2: Resolve configurable thresholds (CLI args > kivo.config.json > defaults)
    const govConfig = resolveGovernanceConfig();
    const decayDays = options.decayDays ?? govConfig.decayDays;
    const minConfidence = options.minConfidence ?? govConfig.minConfidence;
    const contradictionThreshold = govConfig.contradictionThreshold;

    // Fetch active entries (include last_hit_at for value decay)
    let query = `SELECT id, type, title, content, domain, knowledge_domain, confidence, status, updated_at, last_hit_at, embedding
                 FROM entries WHERE status = 'active'`;
    const params: string[] = [];
    if (domain) {
      query += ' AND (type = ? OR domain = ? OR knowledge_domain = ?)';
      params.push(domain, domain, domain);
    }

    const entries = db.prepare(query).all(...params) as EntryRow[];
    const allActions: GovernanceAction[] = [];
    let contradictionResults: PeriodicGovernanceReport['contradictions'] = [];
    const startTime = Date.now();

    const llm = getLlmProvider();

    if (llm) {
      // 1. Staleness detection (fact entries only)
      const stalenessActions = await detectStaleness(llm, entries, dryRun, db);
      allActions.push(...stalenessActions);

      // Filter out entries already actioned by staleness
      const stalenessIds = new Set(stalenessActions.map(a => a.entryId));
      const remainingEntries = entries.filter(e => !stalenessIds.has(e.id));

      // 2. Value decay (configurable days/threshold)
      const decayActions = applyValueDecay(remainingEntries, dryRun, db, { decayDays, minConfidence });
      allActions.push(...decayActions);

      // Filter out archived entries from further checks
      const archivedIds = new Set(decayActions.filter(a => a.newStatus === 'archived').map(a => a.entryId));
      const activeEntries = remainingEntries.filter(e => !archivedIds.has(e.id));

      // 3. Contradiction scan (BGE embedding pre-filter + LLM judge)
      const { actions: contradictionActions, contradictions } = await scanContradictions(
        llm, activeEntries, dryRun, db, { contradictionThreshold },
      );
      allActions.push(...contradictionActions);
      contradictionResults = contradictions;

      // 4. Common knowledge reclaim
      const reclaimActions = await reclaimCommonKnowledge(llm, activeEntries, dryRun, db);
      allActions.push(...reclaimActions);
    } else {
      // No LLM available — only run value decay (doesn't need LLM)
      const decayActions = applyValueDecay(entries, dryRun, db, { decayDays, minConfidence });
      allActions.push(...decayActions);
      console.warn('[KIVO Governance] LLM 不可用，仅执行价值衰减检测');
    }

    // Top-10 high-risk entries (lowest confidence)
    const topRisk = db.prepare(`
      SELECT id, title, confidence, status FROM entries
      WHERE status = 'active'
      ORDER BY confidence ASC
      LIMIT 10
    `).all() as Array<{ id: string; title: string; confidence: number; status: string }>;

    const report: PeriodicGovernanceReport = {
      runAt: new Date().toISOString(),
      totalScanned: entries.length,
      actions: allActions,
      topRiskEntries: topRisk,
      contradictions: contradictionResults,
      dryRun,
    };

    // P1-3: Persist governance run summary to quality_gate_log
    if (!dryRun) {
      const elapsed = Date.now() - startTime;
      const staleness = allActions.filter(a => a.actionType === 'staleness_archived').length;
      const decay = allActions.filter(a => a.actionType === 'value_decay').length;
      const archived = allActions.filter(a => a.actionType === 'value_archived').length;
      const reclaimed = allActions.filter(a => a.actionType === 'common_reclaimed').length;
      const contradictionCount = contradictionResults.length;

      const summaryJson = JSON.stringify({
        totalScanned: entries.length,
        staleness,
        decay,
        archived,
        reclaimed,
        contradictions: contradictionCount,
        elapsedMs: elapsed,
        config: { decayDays, minConfidence, contradictionThreshold },
      });

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO quality_gate_log (
          entry_id, entry_title, source_reference, decision, reason, message,
          matched_entry_id, matched_entry_title, similarity, candidate_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
      `).run(
        null,
        `Governance Run ${report.runAt}`,
        'periodic-governance',
        'governance_summary',
        `scanned=${entries.length} actions=${allActions.length} elapsed=${elapsed}ms`,
        `治理运行完成: ${entries.length} 条扫描, ${allActions.length} 项操作, 耗时 ${elapsed}ms`,
        summaryJson,
        now,
      );
    }

    return report;
  } finally {
    db.close();
  }
}

// ── Restore Command ──────────────────────────────────────────────────────────

export async function runGovernanceRestore(entryId: string): Promise<string> {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}. Run \`kivo init\` first.`);
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  try {
    const entry = db.prepare('SELECT id, title, status, confidence FROM entries WHERE id = ? OR id LIKE ?')
      .get(entryId, `${entryId}%`) as { id: string; title: string; status: string; confidence: number } | undefined;

    if (!entry) {
      return `✗ 未找到条目: ${entryId}`;
    }

    if (entry.status === 'active') {
      return `✓ 条目 [${entry.id.slice(0, 8)}] "${entry.title}" 已经是 active 状态`;
    }

    if (entry.status !== 'archived' && entry.status !== 'deprecated') {
      return `✗ 条目 [${entry.id.slice(0, 8)}] "${entry.title}" 状态为 ${entry.status}，仅支持恢复 archived/deprecated 条目`;
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE entries SET status = ?, updated_at = ? WHERE id = ?')
      .run('active', now, entry.id);

    logGovernanceAction(
      db, entry.id, entry.title,
      'governance_restore',
      'manual_restore',
      `手动恢复: ${entry.status} → active`,
    );

    return `✓ 已恢复条目 [${entry.id.slice(0, 8)}] "${entry.title}": ${entry.status} → active`;
  } finally {
    db.close();
  }
}

// ── Report Formatting ────────────────────────────────────────────────────────

export function formatPeriodicGovernanceReport(report: PeriodicGovernanceReport): string {
  const lines: string[] = [];
  lines.push('═══ KIVO 知识库定期治理报告 ═══');
  lines.push('');
  lines.push(`执行时间: ${report.runAt}`);
  lines.push(`扫描条目: ${report.totalScanned}`);
  lines.push(`模式: ${report.dryRun ? '预览（dry-run）' : '执行'}`);
  lines.push('');

  // Summary
  const staleness = report.actions.filter(a => a.actionType === 'staleness_archived');
  const decay = report.actions.filter(a => a.actionType === 'value_decay');
  const archived = report.actions.filter(a => a.actionType === 'value_archived');
  const reclaimed = report.actions.filter(a => a.actionType === 'common_reclaimed');
  const contradictions = report.actions.filter(a => a.actionType === 'contradiction_flagged');

  lines.push('── 治理摘要 ──');
  lines.push(`  过时归档: ${staleness.length} 条`);
  lines.push(`  价值衰减: ${decay.length} 条`);
  lines.push(`  低值归档: ${archived.length} 条`);
  lines.push(`  常识回收: ${reclaimed.length} 条`);
  lines.push(`  矛盾标记: ${contradictions.length} 对`);
  lines.push('');

  // Actions detail
  if (report.actions.length > 0) {
    lines.push('── 治理动作 ──');
    for (const action of report.actions) {
      const icon = action.newStatus !== action.previousStatus ? '⚠' : '↓';
      lines.push(`  ${icon} [${action.entryId.slice(0, 8)}] ${action.entryTitle}`);
      lines.push(`    类型: ${action.actionType} | ${action.reason}`);
      if (action.previousConfidence !== action.newConfidence) {
        lines.push(`    confidence: ${action.previousConfidence} → ${action.newConfidence}`);
      }
      if (action.previousStatus !== action.newStatus) {
        lines.push(`    status: ${action.previousStatus} → ${action.newStatus}`);
      }
    }
    lines.push('');
  }

  // Contradictions
  if (report.contradictions.length > 0) {
    lines.push('── 矛盾对 ──');
    for (const c of report.contradictions) {
      lines.push(`  ⚡ [${c.entryAId.slice(0, 8)}] ${c.entryATitle}`);
      lines.push(`    ↔ [${c.entryBId.slice(0, 8)}] ${c.entryBTitle}`);
    }
    lines.push('');
  }

  // Top-10 high-risk
  if (report.topRiskEntries.length > 0) {
    lines.push('── Top-10 高风险条目（confidence 最低）──');
    for (let i = 0; i < report.topRiskEntries.length; i++) {
      const e = report.topRiskEntries[i];
      lines.push(`  ${i + 1}. [${e.id.slice(0, 8)}] ${e.title} (confidence: ${e.confidence}, status: ${e.status})`);
    }
    lines.push('');
  }

  if (report.actions.length === 0) {
    lines.push('✓ 知识库状态良好，无需治理动作');
  }

  return lines.join('\n');
}
