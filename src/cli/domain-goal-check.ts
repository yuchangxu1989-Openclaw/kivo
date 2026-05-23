/**
 * FR-M02: 域目标行为约束检查 CLI
 *
 * `kivo domain-goal check` — 检查所有条目是否符合域目标约束
 *
 * 当知识条目违反其所属域的目标约束时，标记为需要审查（status → pending）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { SQLiteDomainGoalStore } from '../domain-goal/sqlite-domain-goal-store.js';
import { enforceConstraints } from '../domain-goal/domain-goal-constraints.js';
import type { KnowledgeEntry } from '../types/index.js';

export interface DomainGoalCheckOptions {
  dryRun?: boolean;
  json?: boolean;
  domain?: string;
}

export interface DomainGoalCheckResult {
  total: number;
  checked: number;
  violations: number;
  flagged: number;
  skipped: number;
  details: Array<{
    id: string;
    title: string;
    domain: string;
    reason: string;
  }>;
  errors: string[];
}

interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  summary: string | null;
  domain: string | null;
  knowledge_domain: string | null;
  status: string;
}

function rowToPartialEntry(row: EntryRow): KnowledgeEntry {
  return {
    id: row.id,
    type: row.type as KnowledgeEntry['type'],
    title: row.title,
    content: row.content,
    summary: row.summary ?? '',
    domain: row.domain ?? undefined,
    knowledgeDomain: row.knowledge_domain ?? undefined,
    status: row.status as KnowledgeEntry['status'],
    confidence: 1,
    source: { type: 'system', reference: '', timestamp: new Date() },
    sources: [],
    tags: [],
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as KnowledgeEntry;
}

export async function runDomainGoalCheck(options: DomainGoalCheckOptions = {}): Promise<string> {
  const dir = process.cwd();
  const configPath = join(dir, 'kivo.config.json');

  let dbPath = String(DEFAULT_CONFIG.dbPath);
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }

  const resolvedDb = resolve(dir, dbPath);
  if (!existsSync(resolvedDb)) {
    return 'Database not found. Run "kivo init" first.';
  }

  const db = new Database(resolvedDb);
  const result: DomainGoalCheckResult = {
    total: 0,
    checked: 0,
    violations: 0,
    flagged: 0,
    skipped: 0,
    details: [],
    errors: [],
  };

  try {
    // Load domain goals from SQLite
    const goalStore = new SQLiteDomainGoalStore({ db });
    const domainGoals = goalStore.list();

    if (domainGoals.length === 0) {
      if (options.json) {
        return JSON.stringify({ ...result, skipped: result.total, message: '未配置域目标，跳过检查' }, null, 2);
      }
      return '⚠ 未配置域目标（domain_goals 表为空），跳过约束检查。\n使用 kivo domain-goal 管理域目标配置。';
    }

    // Load active entries
    let query = `SELECT id, type, title, content, summary, domain, knowledge_domain, status FROM entries WHERE status = 'active'`;
    const params: string[] = [];
    if (options.domain) {
      query += ` AND (domain = ? OR knowledge_domain = ?)`;
      params.push(options.domain, options.domain);
    }
    query += ` ORDER BY created_at ASC`;

    const entries = db.prepare(query).all(...params) as EntryRow[];
    result.total = entries.length;

    const updateStmt = db.prepare(`UPDATE entries SET status = 'pending', updated_at = ? WHERE id = ?`);
    const now = new Date().toISOString();

    for (const row of entries) {
      const entryDomain = row.domain ?? row.knowledge_domain;
      // Only check entries that belong to a domain with configured goals
      const relevantGoals = domainGoals.filter(g => g.domainId === entryDomain);
      if (relevantGoals.length === 0) {
        result.skipped++;
        continue;
      }

      result.checked++;
      try {
        const entry = rowToPartialEntry(row);
        const enforcement = await enforceConstraints(entry, domainGoals);

        if (!enforcement.allowed) {
          result.violations++;
          result.details.push({
            id: row.id,
            title: row.title,
            domain: entryDomain ?? '(none)',
            reason: enforcement.reason ?? '违反域目标约束',
          });

          if (!options.dryRun) {
            updateStmt.run(now, row.id);
            result.flagged++;
          }
        }
      } catch (err) {
        result.errors.push(`${row.id} (${row.title}): ${(err as Error).message}`);
      }
    }

    if (options.json) {
      return JSON.stringify(result, null, 2);
    }

    const lines: string[] = [];
    lines.push(`🎯 域目标约束检查 (FR-M02)`);
    lines.push(`域目标数: ${domainGoals.length} | 总条目: ${result.total} | 已检查: ${result.checked} | 跳过(无匹配域): ${result.skipped}`);
    lines.push(`违规: ${result.violations} | ${options.dryRun ? '将标记待审' : '已标记待审'}: ${options.dryRun ? result.violations : result.flagged}`);
    lines.push('');

    if (result.details.length === 0) {
      lines.push('✅ 所有条目均符合域目标约束');
    } else {
      lines.push(options.dryRun ? '以下条目违反域目标约束（将标记为 pending）:' : '以下条目已标记为 pending:');
      lines.push('');
      for (const d of result.details) {
        lines.push(`  [${d.domain}] ${d.title}`);
        lines.push(`    原因: ${d.reason}`);
      }
    }

    if (result.errors.length > 0) {
      lines.push('');
      lines.push(`⚠ 检查过程中出现 ${result.errors.length} 个错误:`);
      for (const e of result.errors.slice(0, 5)) {
        lines.push(`  ${e}`);
      }
      if (result.errors.length > 5) {
        lines.push(`  ... 及其他 ${result.errors.length - 5} 个错误`);
      }
    }

    return lines.join('\n');
  } finally {
    db.close();
  }
}
