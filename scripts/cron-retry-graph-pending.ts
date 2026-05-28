/**
 * cron-retry-graph-pending.ts
 *
 * 30 分钟周期重试 entries.metadata_json.domainData.graphPending=1 的条目，
 * 并在 metadata 上维护 graphRetryCount + graphState 状态机：
 *   - graphState='pending'   : 待重试（默认值）
 *   - graphState='resolved'  : LLM 关系判定成功，已写入 graph_edges
 *   - graphState='abandoned' : 连续 3 次重试仍失败，停止自动重试
 *
 * 仅改写 metadata_json (JSON 字段)，不需要 ALTER TABLE。
 *
 * 实装：FR-P03 graphPending 兜底（arc42 第 14 章决策 4）。
 *
 * 署名：free-code（OpenClaw ACP Agent）/ 2026-05-24
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { queueSubjectGraphWriteForEntryIds } from '../src/graph/subject-graph-writer.js';

export const DEFAULT_BATCH_LIMIT = 50;
export const DEFAULT_MAX_RETRY = 3;

export type GraphState = 'pending' | 'resolved' | 'abandoned';

export interface PendingRow {
  id: string;
  retryCount: number;
}

export interface RetryStats {
  scanned: number;
  resolved: number;
  retried: number;
  abandoned: number;
  errors: number;
  edgesWritten: number;
}

export type ProcessFn = (
  db: Database.Database,
  entryId: string,
) => Promise<{ failed: number; edgesWritten: number }>;

export interface RunRetryPassOptions {
  limit?: number;
  maxRetry?: number;
  processFn?: ProcessFn;
  logger?: (message: string) => void;
}

interface MetadataPatch {
  graphRetryCount?: number;
  graphState?: GraphState;
  clearPending?: boolean;
  resetRetryCount?: boolean;
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readDomainData(metadata: Record<string, unknown>): Record<string, unknown> {
  const raw = metadata.domainData;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
}

export function selectPendingRows(
  db: Database.Database,
  limit: number = DEFAULT_BATCH_LIMIT,
): PendingRow[] {
  const rows = db
    .prepare(
      `SELECT id,
              CAST(COALESCE(json_extract(metadata_json, '$.domainData.graphRetryCount'), 0) AS INTEGER) AS retryCount
       FROM entries
       WHERE status = 'active'
         AND subject_id IS NOT NULL
         AND json_extract(COALESCE(metadata_json, '{}'), '$.domainData.graphPending') = 1
         AND COALESCE(json_extract(metadata_json, '$.domainData.graphState'), 'pending') <> 'abandoned'
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; retryCount: number | null }>;
  return rows.map((row) => ({
    id: row.id,
    retryCount: typeof row.retryCount === 'number' && Number.isFinite(row.retryCount) ? row.retryCount : 0,
  }));
}

export function updateGraphRetryState(
  db: Database.Database,
  entryId: string,
  patch: MetadataPatch,
): void {
  const existing = db
    .prepare('SELECT metadata_json FROM entries WHERE id = ?')
    .get(entryId) as { metadata_json: string | null } | undefined;
  if (!existing) return;
  const metadata = parseMetadata(existing.metadata_json);
  const domainData = readDomainData(metadata);

  if (patch.graphRetryCount !== undefined) {
    domainData.graphRetryCount = patch.graphRetryCount;
  }
  if (patch.resetRetryCount) {
    delete domainData.graphRetryCount;
  }
  if (patch.graphState) {
    domainData.graphState = patch.graphState;
  }
  if (patch.clearPending) {
    delete domainData.graphPending;
    delete domainData.graphPendingReason;
    delete domainData.graphPendingUpdatedAt;
  }

  metadata.domainData = domainData;
  db.prepare(`UPDATE entries SET metadata_json = ?, updated_at = datetime('now') WHERE id = ?`).run(
    JSON.stringify(metadata),
    entryId,
  );
}

const defaultProcessFn: ProcessFn = async (db, entryId) => {
  const result = await queueSubjectGraphWriteForEntryIds(db, [entryId]);
  return { failed: result.failed, edgesWritten: result.edgesWritten };
};

export async function runRetryPass(
  db: Database.Database,
  options: RunRetryPassOptions = {},
): Promise<RetryStats> {
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const maxRetry = options.maxRetry ?? DEFAULT_MAX_RETRY;
  const processFn = options.processFn ?? defaultProcessFn;
  const log = options.logger ?? (() => {});

  const rows = selectPendingRows(db, limit);
  const stats: RetryStats = {
    scanned: rows.length,
    resolved: 0,
    retried: 0,
    abandoned: 0,
    errors: 0,
    edgesWritten: 0,
  };

  for (const row of rows) {
    try {
      const result = await processFn(db, row.id);
      if (result.failed === 0) {
        updateGraphRetryState(db, row.id, {
          graphState: 'resolved',
          clearPending: true,
          resetRetryCount: true,
        });
        stats.resolved += 1;
        stats.edgesWritten += result.edgesWritten;
        log(`resolved id=${row.id} edges=${result.edgesWritten}`);
      } else {
        const next = row.retryCount + 1;
        if (next >= maxRetry) {
          updateGraphRetryState(db, row.id, {
            graphRetryCount: next,
            graphState: 'abandoned',
          });
          stats.abandoned += 1;
          log(`abandoned id=${row.id} retries=${next}`);
        } else {
          updateGraphRetryState(db, row.id, {
            graphRetryCount: next,
            graphState: 'pending',
          });
          stats.retried += 1;
          log(`retry id=${row.id} count=${next}/${maxRetry}`);
        }
      }
    } catch (error) {
      stats.errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      log(`error id=${row.id} message=${message}`);
    }
  }

  return stats;
}

function resolveDbPath(): string {
  const fromEnv = process.env.KIVO_DB_PATH;
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), 'kivo.db');
}

function ensureLogStream(): { stream: fs.WriteStream; filePath: string } {
  const logsDir = path.resolve(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const date = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');
  const filePath = path.join(logsDir, `cron-graph-pending-${date}.log`);
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  return { stream, filePath };
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(`[cron-retry-graph-pending] DB not found: ${dbPath}`);
    process.exit(1);
  }

  const { stream: logStream, filePath: logFilePath } = ensureLogStream();
  const stamp = () => new Date().toISOString();
  const log = (message: string) => {
    const line = `[${stamp()}] ${message}`;
    console.log(line);
    logStream.write(`${line}\n`);
  };

  log(`start db=${dbPath} log=${logFilePath}`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  try {
    const stats = await runRetryPass(db, { logger: log });
    log(
      `done scanned=${stats.scanned} resolved=${stats.resolved} retried=${stats.retried} abandoned=${stats.abandoned} errors=${stats.errors} edgesWritten=${stats.edgesWritten}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`fatal ${message}`);
    process.exitCode = 1;
  } finally {
    db.close();
    logStream.end();
  }
}

const isDirectInvocation = (() => {
  if (typeof process.argv[1] !== 'string') return false;
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1].endsWith('cron-retry-graph-pending.ts');
  }
})();

if (isDirectInvocation) {
  main();
}
