/**
 * Threshold API Tests — KIVO Wave 1 / C3
 *
 * 覆盖：
 *   - AC-THRESHOLD-1.1: GET 返回当前值（首次 0.75 默认）
 *   - AC-THRESHOLD-1.2: POST 范围校验（<0.5 或 >0.95 → 400）
 *   - AC-THRESHOLD-1.3: POST 写 kivo_meta + 写 history 表
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getThreshold,
  setThreshold,
  validateThreshold,
  getThresholdHistory,
  ensureThresholdSchema,
  DEFAULT_THRESHOLD,
  THRESHOLD_MIN,
  THRESHOLD_MAX,
  THRESHOLD_META_KEY,
} from '@/lib/classify/threshold-store';

// ─── Test DB Setup ───────────────────────────────────────────────────────────

let db: Database.Database;

function setupTestDb(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE kivo_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ensureThresholdSchema(testDb);
  return testDb;
}

beforeEach(() => {
  db = setupTestDb();
});

afterEach(() => {
  db.close();
});

// ─── AC-THRESHOLD-1.1: GET 返回当前值 ────────────────────────────────────────

describe('getThreshold', () => {
  it('returns default 0.75 when no value in DB', () => {
    const result = getThreshold(db);
    expect(result.threshold).toBe(DEFAULT_THRESHOLD);
    expect(result.threshold).toBe(0.75);
    expect(result.updated_at).toBeDefined();
  });

  it('returns stored value when present in kivo_meta', () => {
    db.prepare(
      `INSERT INTO kivo_meta (key, value, updated_at) VALUES (?, ?, ?)`
    ).run(THRESHOLD_META_KEY, '0.85', '2026-05-24T10:00:00.000Z');

    const result = getThreshold(db);
    expect(result.threshold).toBe(0.85);
    expect(result.updated_at).toBe('2026-05-24T10:00:00.000Z');
  });
});

// ─── AC-THRESHOLD-1.2: POST 范围校验 ─────────────────────────────────────────

describe('validateThreshold', () => {
  it('rejects null/undefined', () => {
    expect(validateThreshold(null)).toEqual({ ok: false, error: 'threshold is required' });
    expect(validateThreshold(undefined)).toEqual({ ok: false, error: 'threshold is required' });
  });

  it('rejects non-numeric values', () => {
    expect(validateThreshold('abc')).toEqual({ ok: false, error: 'threshold must be a number' });
    expect(validateThreshold(NaN)).toEqual({ ok: false, error: 'threshold must be a number' });
  });

  it('rejects values below 0.5', () => {
    const result = validateThreshold(0.49);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('between');
      expect(result.error).toContain(String(THRESHOLD_MIN));
    }
  });

  it('rejects values above 0.95', () => {
    const result = validateThreshold(0.96);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('between');
      expect(result.error).toContain(String(THRESHOLD_MAX));
    }
  });

  it('accepts boundary value 0.5', () => {
    expect(validateThreshold(0.5)).toEqual({ ok: true, value: 0.5 });
  });

  it('accepts boundary value 0.95', () => {
    expect(validateThreshold(0.95)).toEqual({ ok: true, value: 0.95 });
  });

  it('accepts valid mid-range value', () => {
    expect(validateThreshold(0.75)).toEqual({ ok: true, value: 0.75 });
    expect(validateThreshold(0.8)).toEqual({ ok: true, value: 0.8 });
  });

  it('accepts string-encoded numbers', () => {
    expect(validateThreshold('0.7')).toEqual({ ok: true, value: 0.7 });
  });
});

// ─── AC-THRESHOLD-1.3: POST 写 kivo_meta + 写 history ────────────────────────

describe('setThreshold', () => {
  it('writes value to kivo_meta', () => {
    setThreshold(0.8, db);

    const row = db.prepare(
      `SELECT value FROM kivo_meta WHERE key = ?`
    ).get(THRESHOLD_META_KEY) as { value: string };

    expect(row).toBeDefined();
    expect(Number(row.value)).toBe(0.8);
  });

  it('returns the new threshold and updated_at', () => {
    const result = setThreshold(0.85, db);
    expect(result.threshold).toBe(0.85);
    expect(result.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('records history entry with old_value=null on first set', () => {
    setThreshold(0.8, db);

    const history = getThresholdHistory(10, db);
    expect(history).toHaveLength(1);
    expect(history[0].old_value).toBeNull();
    expect(history[0].new_value).toBe(0.8);
  });

  it('records history entry with correct old_value on update', () => {
    setThreshold(0.8, db);
    setThreshold(0.9, db);

    const history = getThresholdHistory(10, db);
    expect(history).toHaveLength(2);
    // Most recent first
    expect(history[0].new_value).toBe(0.9);
    expect(history[0].old_value).toBe(0.8);
    expect(history[1].new_value).toBe(0.8);
    expect(history[1].old_value).toBeNull();
  });

  it('upserts kivo_meta (no duplicate key error)', () => {
    setThreshold(0.7, db);
    setThreshold(0.8, db);
    setThreshold(0.9, db);

    const rows = db.prepare(
      `SELECT * FROM kivo_meta WHERE key = ?`
    ).all(THRESHOLD_META_KEY);
    expect(rows).toHaveLength(1);
  });

  it('getThreshold reflects latest setThreshold', () => {
    setThreshold(0.88, db);
    const result = getThreshold(db);
    expect(result.threshold).toBe(0.88);
  });
});

// ─── getThresholdHistory ─────────────────────────────────────────────────────

describe('getThresholdHistory', () => {
  it('returns empty array when no history', () => {
    const history = getThresholdHistory(10, db);
    expect(history).toEqual([]);
  });

  it('respects limit parameter', () => {
    setThreshold(0.6, db);
    setThreshold(0.7, db);
    setThreshold(0.8, db);

    const history = getThresholdHistory(2, db);
    expect(history).toHaveLength(2);
    expect(history[0].new_value).toBe(0.8);
    expect(history[1].new_value).toBe(0.7);
  });
});
