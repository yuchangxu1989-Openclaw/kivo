/**
 * ThresholdStore — KIVO Wave 1 / C3
 *
 * 管理分类置信度阈值的持久化存储。
 * 使用 kivo_meta 表 key='classify.confidence_threshold' 存储当前值，
 * threshold_history 表记录变更历史。
 *
 * spec: FR-CLASSIFY-2 / FR-CONFIG-1
 */

import Database from 'better-sqlite3';
import { openWebDb } from '@/lib/db';

// ─── Constants ───────────────────────────────────────────────────────────────

export const THRESHOLD_META_KEY = 'classify.confidence_threshold';
export const DEFAULT_THRESHOLD = 0.75;
export const THRESHOLD_MIN = 0.5;
export const THRESHOLD_MAX = 0.95;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ThresholdRecord {
  threshold: number;
  updated_at: string;
}

export interface ThresholdHistoryEntry {
  id: number;
  old_value: number | null;
  new_value: number;
  changed_at: string;
}

// ─── Schema bootstrap ────────────────────────────────────────────────────────

export function ensureThresholdSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threshold_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      old_value REAL,
      new_value REAL NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateThreshold(value: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (value === null || value === undefined) {
    return { ok: false, error: 'threshold is required' };
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) {
    return { ok: false, error: 'threshold must be a number' };
  }
  if (num < THRESHOLD_MIN || num > THRESHOLD_MAX) {
    return { ok: false, error: `threshold must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}` };
  }
  return { ok: true, value: num };
}

// ─── Read ────────────────────────────────────────────────────────────────────

export function getThreshold(db?: Database.Database): ThresholdRecord {
  const conn = db || openWebDb(true);
  try {
    const row = conn.prepare(
      `SELECT value, updated_at FROM kivo_meta WHERE key = ?`
    ).get(THRESHOLD_META_KEY) as { value: string; updated_at: string } | undefined;

    if (!row) {
      return { threshold: DEFAULT_THRESHOLD, updated_at: new Date().toISOString() };
    }
    return { threshold: Number(row.value), updated_at: row.updated_at };
  } finally {
    if (!db) conn.close();
  }
}

// ─── Write ───────────────────────────────────────────────────────────────────

export function setThreshold(newValue: number, db?: Database.Database): ThresholdRecord {
  const conn = db || openWebDb(false);
  try {
    ensureThresholdSchema(conn);

    const now = new Date().toISOString();

    // Read current value for history
    const current = conn.prepare(
      `SELECT value FROM kivo_meta WHERE key = ?`
    ).get(THRESHOLD_META_KEY) as { value: string } | undefined;

    const oldValue = current ? Number(current.value) : null;

    // Upsert kivo_meta
    conn.prepare(`
      INSERT INTO kivo_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(THRESHOLD_META_KEY, String(newValue), now);

    // Write history
    conn.prepare(`
      INSERT INTO threshold_history (old_value, new_value, changed_at)
      VALUES (?, ?, ?)
    `).run(oldValue, newValue, now);

    return { threshold: newValue, updated_at: now };
  } finally {
    if (!db) conn.close();
  }
}

// ─── History ─────────────────────────────────────────────────────────────────

export function getThresholdHistory(limit = 20, db?: Database.Database): ThresholdHistoryEntry[] {
  const conn = db || openWebDb(true);
  try {
    ensureThresholdSchema(conn);
    return conn.prepare(
      `SELECT id, old_value, new_value, changed_at FROM threshold_history ORDER BY id DESC LIMIT ?`
    ).all(limit) as ThresholdHistoryEntry[];
  } finally {
    if (!db) conn.close();
  }
}
