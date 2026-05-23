/**
 * GET /api/v1/research/queue — Research scheduler queue state.
 * Returns running count, queued count, and remaining daily budget.
 */

import { NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_DAILY_BUDGET = 50;

interface ResearchQueueState {
  running: number;
  queued: number;
  budgetRemaining: number;
  maxConcurrent: number;
  dailyBudget: number;
  status: 'available' | 'at_capacity' | 'budget_exhausted';
}

function utcDayRange(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function GET() {
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');

    // Ensure table exists check
    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='research_scheduler_runs'
    `).get();

    if (!tableExists) {
      const state: ResearchQueueState = {
        running: 0,
        queued: 0,
        budgetRemaining: DEFAULT_DAILY_BUDGET,
        maxConcurrent: DEFAULT_MAX_CONCURRENT,
        dailyBudget: DEFAULT_DAILY_BUDGET,
        status: 'available',
      };
      return NextResponse.json({ data: state } satisfies ApiResponse<ResearchQueueState>);
    }

    // Count running tasks
    const runningRow = db.prepare(`
      SELECT COUNT(*) AS count FROM research_scheduler_runs WHERE status = 'running'
    `).get() as { count: number };
    const running = runningRow.count;

    // Count today's budget usage
    const now = new Date();
    const range = utcDayRange(now);
    const usageRow = db.prepare(`
      SELECT COUNT(*) AS count FROM research_scheduler_runs
      WHERE created_at >= ? AND created_at < ?
    `).get(range.start, range.end) as { count: number };
    const budgetUsed = usageRow.count;

    // Read config from kivo_config table if available
    let maxConcurrent = DEFAULT_MAX_CONCURRENT;
    let dailyBudget = DEFAULT_DAILY_BUDGET;

    const configTableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='kivo_config'
    `).get();

    if (configTableExists) {
      const maxConcRow = db.prepare(`
        SELECT value FROM kivo_config WHERE key = 'research.maxConcurrent'
      `).get() as { value: string } | undefined;
      if (maxConcRow) maxConcurrent = parseInt(maxConcRow.value, 10) || DEFAULT_MAX_CONCURRENT;

      const budgetRow = db.prepare(`
        SELECT value FROM kivo_config WHERE key = 'research.dailyBudget'
      `).get() as { value: string } | undefined;
      if (budgetRow) dailyBudget = parseInt(budgetRow.value, 10) || DEFAULT_DAILY_BUDGET;
    }

    const budgetRemaining = Math.max(0, dailyBudget - budgetUsed);

    // Count queued (pending) tasks — tasks that are neither running nor completed today
    const queuedRow = db.prepare(`
      SELECT COUNT(*) AS count FROM research_scheduler_runs
      WHERE status = 'queued'
    `).get() as { count: number } | undefined;
    const queued = queuedRow?.count ?? 0;

    let status: ResearchQueueState['status'] = 'available';
    if (budgetRemaining <= 0) {
      status = 'budget_exhausted';
    } else if (running >= maxConcurrent) {
      status = 'at_capacity';
    }

    const state: ResearchQueueState = {
      running,
      queued,
      budgetRemaining,
      maxConcurrent,
      dailyBudget,
      status,
    };

    return NextResponse.json({ data: state } satisfies ApiResponse<ResearchQueueState>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  } finally {
    db?.close();
  }
}
