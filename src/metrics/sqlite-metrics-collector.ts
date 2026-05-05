/**
 * SQLiteMetricsCollector — SQLite-backed metrics persistence
 *
 * Drop-in replacement for the in-memory MetricsCollector.
 * Persists metric records to SQLite for survival across restarts.
 */

import Database from 'better-sqlite3';
import type {
  SearchMetricRecord,
  GapDetectionRecord,
  DistributionRecord,
  ConflictMetricRecord,
  AggregatedMetrics,
  TimeWindow,
} from './metrics-types.js';

export interface SQLiteMetricsCollectorOptions {
  db: Database.Database;
}

export class SQLiteMetricsCollector {
  private readonly db: Database.Database;

  constructor(options: SQLiteMetricsCollectorOptions) {
    this.db = options.db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics_search (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        query TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        hit INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metrics_gap_detection (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        total_questions INTEGER NOT NULL,
        covered_questions INTEGER NOT NULL,
        uncovered_questions INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metrics_distribution (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        target_count INTEGER NOT NULL,
        success_count INTEGER NOT NULL,
        failure_count INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metrics_conflict (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        produced INTEGER NOT NULL,
        resolved INTEGER NOT NULL,
        pending INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_metrics_search_ts ON metrics_search(timestamp);
      CREATE INDEX IF NOT EXISTS idx_metrics_gap_ts ON metrics_gap_detection(timestamp);
      CREATE INDEX IF NOT EXISTS idx_metrics_dist_ts ON metrics_distribution(timestamp);
      CREATE INDEX IF NOT EXISTS idx_metrics_conflict_ts ON metrics_conflict(timestamp);
    `);
  }

  // ── AC1: 检索命中率 ──

  recordSearch(query: string, resultCount: number): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO metrics_search (timestamp, query, result_count, hit) VALUES (?, ?, ?, ?)'
    ).run(now, query, resultCount, resultCount > 0 ? 1 : 0);
  }

  // ── AC2: 缺口检测覆盖率 ──

  recordGapDetection(totalQuestions: number, coveredQuestions: number): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO metrics_gap_detection (timestamp, total_questions, covered_questions, uncovered_questions) VALUES (?, ?, ?, ?)'
    ).run(now, totalQuestions, coveredQuestions, totalQuestions - coveredQuestions);
  }

  // ── AC3: 规则分发到达率 ──

  recordDistribution(ruleId: string, targetCount: number, successCount: number, failureCount: number): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO metrics_distribution (timestamp, rule_id, target_count, success_count, failure_count) VALUES (?, ?, ?, ?, ?)'
    ).run(now, ruleId, targetCount, successCount, failureCount);
  }

  // ── AC4: 冲突解决率 ──

  recordConflict(produced: number, resolved: number, pending: number): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO metrics_conflict (timestamp, produced, resolved, pending) VALUES (?, ?, ?, ?)'
    ).run(now, produced, resolved, pending);
  }

  // ── AC5: 聚合接口 ──

  aggregate(window?: TimeWindow): AggregatedMetrics {
    const windowClause = window
      ? ' WHERE timestamp >= ? AND timestamp <= ?'
      : '';
    const windowParams = window
      ? [window.start.toISOString(), window.end.toISOString()]
      : [];

    // Search metrics
    const searchRows = this.db.prepare(
      `SELECT result_count, hit FROM metrics_search${windowClause}`
    ).all(...windowParams) as Array<{ result_count: number; hit: number }>;

    const totalQueries = searchRows.length;
    const hitCount = searchRows.filter(r => r.hit === 1).length;

    // Gap detection metrics
    const gapRows = this.db.prepare(
      `SELECT total_questions, covered_questions, uncovered_questions, timestamp FROM metrics_gap_detection${windowClause} ORDER BY timestamp ASC`
    ).all(...windowParams) as Array<{ total_questions: number; covered_questions: number; uncovered_questions: number; timestamp: string }>;

    const totalRuns = gapRows.length;
    const averageCoverage = totalRuns > 0
      ? gapRows.reduce((sum, r) => sum + (r.total_questions > 0 ? r.covered_questions / r.total_questions : 0), 0) / totalRuns
      : 0;
    const lastGapRun = gapRows.length > 0 ? gapRows[gapRows.length - 1] : undefined;

    // Distribution metrics
    const distRows = this.db.prepare(
      `SELECT target_count, success_count, failure_count FROM metrics_distribution${windowClause}`
    ).all(...windowParams) as Array<{ target_count: number; success_count: number; failure_count: number }>;

    const totalDistributions = distRows.length;
    const totalTargets = distRows.reduce((s, r) => s + r.target_count, 0);
    const totalSuccesses = distRows.reduce((s, r) => s + r.success_count, 0);
    const totalFailures = distRows.reduce((s, r) => s + r.failure_count, 0);

    // Conflict metrics
    const conflictRows = this.db.prepare(
      `SELECT produced, resolved, pending FROM metrics_conflict${windowClause}`
    ).all(...windowParams) as Array<{ produced: number; resolved: number; pending: number }>;

    const totalProduced = conflictRows.reduce((s, r) => s + r.produced, 0);
    const totalResolved = conflictRows.reduce((s, r) => s + r.resolved, 0);
    const totalPending = conflictRows.reduce((s, r) => s + r.pending, 0);

    return {
      search: {
        totalQueries,
        hitCount,
        missCount: totalQueries - hitCount,
        hitRate: totalQueries > 0 ? hitCount / totalQueries : 0,
      },
      gapDetection: {
        totalRuns,
        averageCoverage,
        lastRun: lastGapRun ? {
          timestamp: new Date(lastGapRun.timestamp),
          totalQuestions: lastGapRun.total_questions,
          coveredQuestions: lastGapRun.covered_questions,
          uncoveredQuestions: lastGapRun.uncovered_questions,
        } : undefined,
      },
      distribution: {
        totalDistributions,
        totalTargets,
        totalSuccesses,
        totalFailures,
        deliveryRate: totalTargets > 0 ? totalSuccesses / totalTargets : 0,
      },
      conflict: {
        totalProduced,
        totalResolved,
        totalPending,
        resolutionRate: totalProduced > 0 ? totalResolved / totalProduced : 0,
      },
      collectedAt: new Date(),
    };
  }

  getRawRecords() {
    const search = (this.db.prepare('SELECT * FROM metrics_search ORDER BY timestamp ASC').all() as Array<{
      timestamp: string; query: string; result_count: number; hit: number;
    }>).map(r => ({
      timestamp: new Date(r.timestamp),
      query: r.query,
      resultCount: r.result_count,
      hit: r.hit === 1,
    }));

    const gapDetection = (this.db.prepare('SELECT * FROM metrics_gap_detection ORDER BY timestamp ASC').all() as Array<{
      timestamp: string; total_questions: number; covered_questions: number; uncovered_questions: number;
    }>).map(r => ({
      timestamp: new Date(r.timestamp),
      totalQuestions: r.total_questions,
      coveredQuestions: r.covered_questions,
      uncoveredQuestions: r.uncovered_questions,
    }));

    const distribution = (this.db.prepare('SELECT * FROM metrics_distribution ORDER BY timestamp ASC').all() as Array<{
      timestamp: string; rule_id: string; target_count: number; success_count: number; failure_count: number;
    }>).map(r => ({
      timestamp: new Date(r.timestamp),
      ruleId: r.rule_id,
      targetCount: r.target_count,
      successCount: r.success_count,
      failureCount: r.failure_count,
    }));

    const conflict = (this.db.prepare('SELECT * FROM metrics_conflict ORDER BY timestamp ASC').all() as Array<{
      timestamp: string; produced: number; resolved: number; pending: number;
    }>).map(r => ({
      timestamp: new Date(r.timestamp),
      produced: r.produced,
      resolved: r.resolved,
      pending: r.pending,
    }));

    return { search, gapDetection, distribution, conflict };
  }

  clear(): void {
    this.db.exec(`
      DELETE FROM metrics_search;
      DELETE FROM metrics_gap_detection;
      DELETE FROM metrics_distribution;
      DELETE FROM metrics_conflict;
    `);
  }
}
