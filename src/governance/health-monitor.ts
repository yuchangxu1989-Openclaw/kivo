/**
 * Knowledge Health Monitor — MECE 覆盖度监控 + 时效性 + 使用追踪 (FR-E06 + FR-N05)
 *
 * Generates a health report covering:
 * - Coverage: domain/type distribution, empty/bloated categories
 * - Freshness: stale entries (>90 days without update)
 * - Quality: low-confidence cluster ratio
 * - Usage: zero-use entries older than 30 days
 */

import type Database from 'better-sqlite3';

export interface HealthReport {
  timestamp: string;
  totalEntries: number;
  activeEntries: number;
  healthScore: number; // 0-100
  dimensions: {
    coverageScore: number;
    freshnessScore: number;
    qualityScore: number;
    usageScore: number;
  };
  alerts: HealthAlert[];
}

export interface HealthAlert {
  type: 'empty_category' | 'bloated_category' | 'stale_entries' | 'low_quality_cluster' | 'unused_entries';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  affectedCount: number;
}

interface CategoryCount {
  category: string;
  count: number;
}

const STALE_DAYS = 90;
const BLOATED_THRESHOLD = 100;
const LOW_CONFIDENCE_THRESHOLD = 0.7;
const UNUSED_GRACE_DAYS = 30;

/**
 * Ensure usage tracking columns exist (idempotent).
 */
export function ensureUsageColumns(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
  const colNames = new Set(columns.map(c => c.name));

  if (!colNames.has('usage_count')) {
    db.exec('ALTER TABLE entries ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!colNames.has('last_used_at')) {
    db.exec('ALTER TABLE entries ADD COLUMN last_used_at TEXT');
  }
}

/**
 * Record a usage hit for one or more entry IDs.
 */
export function recordUsage(db: Database.Database, entryIds: string[]): void {
  if (entryIds.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'UPDATE entries SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?',
  );
  const tx = db.transaction(() => {
    for (const id of entryIds) {
      stmt.run(now, id);
    }
  });
  tx();
}

/**
 * Generate a comprehensive health report for the knowledge base.
 */
export function generateHealthReport(db: Database.Database): HealthReport {
  ensureUsageColumns(db);

  const now = new Date();
  const alerts: HealthAlert[] = [];

  // Total and active counts
  const totalEntries = (db.prepare('SELECT COUNT(*) as cnt FROM entries').get() as { cnt: number }).cnt;
  const activeEntries = (db.prepare("SELECT COUNT(*) as cnt FROM entries WHERE status = 'active'").get() as { cnt: number }).cnt;

  // ── Coverage Score ──────────────────────────────────────────────────────────
  const domainDist = db.prepare(
    "SELECT COALESCE(domain, '(none)') as category, COUNT(*) as count FROM entries WHERE status = 'active' GROUP BY domain",
  ).all() as CategoryCount[];

  const typeDist = db.prepare(
    "SELECT type as category, COUNT(*) as count FROM entries WHERE status = 'active' GROUP BY type",
  ).all() as CategoryCount[];

  // Detect bloated categories
  let bloatedCount = 0;
  for (const row of [...domainDist, ...typeDist]) {
    if (row.count > BLOATED_THRESHOLD) {
      bloatedCount++;
      alerts.push({
        type: 'bloated_category',
        severity: 'warning',
        message: `Category "${row.category}" has ${row.count} entries (>${BLOATED_THRESHOLD})`,
        affectedCount: row.count,
      });
    }
  }

  // Detect empty domains (if we know expected domains from domain goals)
  const emptyDomains = domainDist.filter(d => d.count === 0);
  if (emptyDomains.length > 0) {
    alerts.push({
      type: 'empty_category',
      severity: 'info',
      message: `${emptyDomains.length} domain(s) have zero entries`,
      affectedCount: emptyDomains.length,
    });
  }

  // Coverage score: penalize if too few categories or heavily skewed
  const categoryCount = domainDist.filter(d => d.category !== '(none)').length;
  const coverageScore = Math.min(100, Math.max(0,
    categoryCount >= 3 ? 100 - bloatedCount * 10 : 50 + categoryCount * 15 - bloatedCount * 10,
  ));

  // ── Freshness Score ─────────────────────────────────────────────────────────
  const staleCutoff = new Date(now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const staleCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM entries WHERE status = 'active' AND created_at < ? AND updated_at < ?",
  ).get(staleCutoff, staleCutoff) as { cnt: number }).cnt;

  const staleRatio = activeEntries > 0 ? staleCount / activeEntries : 0;
  const freshnessScore = Math.round(Math.max(0, 100 - staleRatio * 150));

  if (staleCount > 0) {
    const severity = staleRatio > 0.5 ? 'critical' : staleRatio > 0.2 ? 'warning' : 'info';
    alerts.push({
      type: 'stale_entries',
      severity,
      message: `${staleCount} entries not updated in ${STALE_DAYS}+ days (${(staleRatio * 100).toFixed(1)}%)`,
      affectedCount: staleCount,
    });
  }

  // ── Quality Score ───────────────────────────────────────────────────────────
  const lowQualityCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM entries WHERE status = 'active' AND confidence < ?",
  ).get(LOW_CONFIDENCE_THRESHOLD) as { cnt: number }).cnt;

  const lowQualityRatio = activeEntries > 0 ? lowQualityCount / activeEntries : 0;
  const qualityScore = Math.round(Math.max(0, 100 - lowQualityRatio * 120));

  if (lowQualityCount > 0) {
    const severity = lowQualityRatio > 0.4 ? 'critical' : lowQualityRatio > 0.2 ? 'warning' : 'info';
    alerts.push({
      type: 'low_quality_cluster',
      severity,
      message: `${lowQualityCount} entries with confidence < ${LOW_CONFIDENCE_THRESHOLD} (${(lowQualityRatio * 100).toFixed(1)}%)`,
      affectedCount: lowQualityCount,
    });
  }

  // ── Usage Score ─────────────────────────────────────────────────────────────
  const unusedGraceCutoff = new Date(now.getTime() - UNUSED_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const unusedCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM entries WHERE status = 'active' AND usage_count = 0 AND created_at < ?",
  ).get(unusedGraceCutoff) as { cnt: number }).cnt;

  const unusedRatio = activeEntries > 0 ? unusedCount / activeEntries : 0;
  const usageScore = Math.round(Math.max(0, 100 - unusedRatio * 100));

  if (unusedCount > 0) {
    const severity = unusedRatio > 0.7 ? 'critical' : unusedRatio > 0.4 ? 'warning' : 'info';
    alerts.push({
      type: 'unused_entries',
      severity,
      message: `${unusedCount} entries never used (created ${UNUSED_GRACE_DAYS}+ days ago, ${(unusedRatio * 100).toFixed(1)}%)`,
      affectedCount: unusedCount,
    });
  }

  // ── Composite Health Score ──────────────────────────────────────────────────
  const healthScore = Math.round(
    coverageScore * 0.2 + freshnessScore * 0.3 + qualityScore * 0.3 + usageScore * 0.2,
  );

  return {
    timestamp: now.toISOString(),
    totalEntries,
    activeEntries,
    healthScore,
    dimensions: {
      coverageScore,
      freshnessScore,
      qualityScore,
      usageScore,
    },
    alerts,
  };
}

/**
 * Format a health report as human-readable text.
 */
export function formatHealthReport(report: HealthReport): string {
  const lines: string[] = [];
  lines.push('═══ KIVO Knowledge Health Report ═══');
  lines.push(`Time: ${report.timestamp}`);
  lines.push(`Entries: ${report.activeEntries} active / ${report.totalEntries} total`);
  lines.push(`Health Score: ${report.healthScore}/100`);
  lines.push('');
  lines.push('Dimensions:');
  lines.push(`  Coverage:  ${report.dimensions.coverageScore}/100`);
  lines.push(`  Freshness: ${report.dimensions.freshnessScore}/100`);
  lines.push(`  Quality:   ${report.dimensions.qualityScore}/100`);
  lines.push(`  Usage:     ${report.dimensions.usageScore}/100`);

  if (report.alerts.length > 0) {
    lines.push('');
    lines.push('Alerts:');
    for (const alert of report.alerts) {
      const icon = alert.severity === 'critical' ? '🔴' : alert.severity === 'warning' ? '🟡' : '🔵';
      lines.push(`  ${icon} [${alert.type}] ${alert.message}`);
    }
  }

  return lines.join('\n');
}
