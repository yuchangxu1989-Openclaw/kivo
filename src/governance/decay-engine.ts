/**
 * Decay Engine — 时效性衰减 (FR-E06)
 *
 * Applies confidence decay to entries that haven't been updated or used:
 * - >90 days without update AND usage_count=0 → confidence *= 0.9
 * - >180 days without update → confidence *= 0.8
 * - confidence < 0.5 after decay → status = 'stale'
 */

import type Database from 'better-sqlite3';
import { ensureUsageColumns } from './health-monitor.js';

export interface DecayReport {
  decayed: number;
  stalemarked: number;
}

const DECAY_90_DAYS = 90;
const DECAY_180_DAYS = 180;
const DECAY_FACTOR_90 = 0.9;
const DECAY_FACTOR_180 = 0.8;
const STALE_THRESHOLD = 0.5;

/**
 * Apply time-based confidence decay to knowledge entries.
 *
 * Rules:
 * - >90 days since updated_at AND usage_count=0 → confidence *= 0.9
 * - >180 days since updated_at (regardless of usage) → confidence *= 0.8
 * - After decay, if confidence < 0.5 → status = 'stale'
 *
 * Decay is applied once per governance run (not cumulative within a single run).
 */
export function applyDecay(db: Database.Database): DecayReport {
  ensureUsageColumns(db);

  const now = new Date();
  const cutoff90 = new Date(now.getTime() - DECAY_90_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const cutoff180 = new Date(now.getTime() - DECAY_180_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const updatedAt = now.toISOString();

  let decayed = 0;
  let stalemarked = 0;

  const tx = db.transaction(() => {
    // Phase 1: Decay entries >180 days (stronger decay, regardless of usage)
    const decay180 = db.prepare(
      `UPDATE entries SET confidence = confidence * ?, updated_at = ?
       WHERE status = 'active' AND updated_at < ? AND confidence >= ?`,
    );
    const result180 = decay180.run(DECAY_FACTOR_180, updatedAt, cutoff180, STALE_THRESHOLD);
    decayed += result180.changes;

    // Phase 2: Decay entries >90 days with zero usage (lighter decay)
    // Exclude those already decayed in phase 1 (updated_at was just set)
    const decay90 = db.prepare(
      `UPDATE entries SET confidence = confidence * ?, updated_at = ?
       WHERE status = 'active' AND updated_at < ? AND updated_at >= ? AND usage_count = 0 AND confidence >= ?`,
    );
    const result90 = decay90.run(DECAY_FACTOR_90, updatedAt, cutoff90, cutoff180, STALE_THRESHOLD);
    decayed += result90.changes;

    // Phase 3: Mark entries with confidence < threshold as stale
    const markStale = db.prepare(
      `UPDATE entries SET status = 'stale', updated_at = ?
       WHERE status = 'active' AND confidence < ?`,
    );
    const staleResult = markStale.run(updatedAt, STALE_THRESHOLD);
    stalemarked = staleResult.changes;
  });

  tx();

  return { decayed, stalemarked };
}
