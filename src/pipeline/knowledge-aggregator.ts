/**
 * Knowledge Aggregator — Stage 2 of FR-A05 two-stage pipeline.
 *
 * Reads unconsumed staging materials, performs LLM-based semantic clustering
 * and abstraction, then writes aggregated knowledge through the quality gate
 * into the entries table.
 *
 * This module provides a standalone entry point for Stage 2 that can be
 * triggered independently of Stage 1 extraction (e.g., via CLI or cron).
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { resolveLlmConfig } from '../cli/resolve-llm-config.js';
import { OpenAILLMProvider, resolveLlmTimeoutMs } from '../extraction/llm-extractor.js';
import { KnowledgeRepository, SQLiteProvider } from '../repository/index.js';
import { ensureOperationalTables } from '../utils/operational-db.js';
import {
  aggregateKnowledgeMaterials,
  normalizeAggregatedItem,
  type KnowledgeMaterial,
} from '../cli/session-knowledge-aggregator.js';
import type { KnowledgeEntry } from '../types/index.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AggregatorOptions {
  /** Skip quality gate checks on produced entries */
  skipQualityGate?: boolean;
  /** Maximum materials to process in one run (env: KIVO_AGGREGATOR_MAX_MATERIALS) */
  maxMaterials?: number;
  /** Working directory for resolving DB path */
  cwd?: string;
  /** Dry run — don't write to DB */
  dryRun?: boolean;
}

export interface AggregatorResult {
  /** Number of pending staging materials found */
  pendingMaterials: number;
  /** Number of aggregated knowledge entries produced */
  knowledgeProduced: number;
  /** Number of entries that passed quality gate and were written */
  knowledgeWritten: number;
  /** Number of staging materials marked as consumed */
  materialsConsumed: number;
  /** Errors encountered */
  errors: string[];
  /** Governance report id when persisted */
  reportId?: string;
}

interface StagingMaterialRow {
  id: string;
  cluster_id: number;
  cluster_size: number;
  title: string | null;
  content: string;
  nature: string | null;
  function_tag: string | null;
  knowledge_domain: string | null;
  source: string | null;
  confidence: number | null;
  tags_json: string;
  similar_sentences_json: string;
  source_refs_json: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseTagsJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { tags?: unknown }).tags)) {
      return ((parsed as { tags: unknown[] }).tags).filter((v): v is string => typeof v === 'string');
    }
  } catch {
    return [];
  }
  return [];
}

function rowToMaterial(row: StagingMaterialRow): KnowledgeMaterial {
  return {
    clusterId: row.cluster_id,
    clusterSize: row.cluster_size,
    content: row.content,
    title: row.title ?? undefined,
    nature: row.nature ?? undefined,
    function: row.function_tag ?? undefined,
    domain: row.knowledge_domain ?? undefined,
    source: row.source ?? undefined,
    confidence: row.confidence ?? undefined,
    tags: parseTagsJson(row.tags_json),
    similarSentences: parseJsonArray(row.similar_sentences_json).filter((v): v is string => typeof v === 'string'),
    sourceRefs: parseJsonArray(row.source_refs_json).map(v => {
      const ref = v as { sessionId?: unknown; timestamp?: unknown };
      return {
        sessionId: typeof ref.sessionId === 'string' ? ref.sessionId : '',
        timestamp: typeof ref.timestamp === 'string' ? ref.timestamp : '',
      };
    }),
  };
}

function materialIdFromRow(row: StagingMaterialRow): string {
  return createHash('sha256')
    .update(`${row.cluster_id}:${row.content}`)
    .digest('hex')
    .slice(0, 16);
}

// ── Main aggregation logic ───────────────────────────────────────────────────

/**
 * Run Stage 2 knowledge aggregation independently.
 *
 * 1. Reads all pending staging materials from DB
 * 2. Sends them to LLM for semantic clustering + abstraction
 * 3. Validates produced knowledge through quality gate
 * 4. Writes passing entries to the knowledge base
 * 5. Marks consumed staging materials
 */
export async function runKnowledgeAggregation(
  options: AggregatorOptions = {},
): Promise<AggregatorResult> {
  const {
    skipQualityGate = false,
    maxMaterials,
    cwd: workDir,
    dryRun = false,
  } = options;

  const result: AggregatorResult = {
    pendingMaterials: 0,
    knowledgeProduced: 0,
    knowledgeWritten: 0,
    materialsConsumed: 0,
    errors: [],
  };

  // Resolve DB path
  const dir = workDir ?? process.cwd();
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = String(DEFAULT_CONFIG.dbPath);
  if (existsSync(configPath)) {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof cfg.dbPath === 'string') dbPath = cfg.dbPath;
  }
  const resolvedDb = resolve(dir, dbPath);

  if (!existsSync(resolvedDb)) {
    result.errors.push(`Database not found at ${resolvedDb}. Run "kivo init" first.`);
    return result;
  }

  // Resolve LLM
  const llmConfig = resolveLlmConfig();
  if ('error' in llmConfig) {
    result.errors.push(`LLM config error: ${llmConfig.error}`);
    return result;
  }

  const llm = new OpenAILLMProvider({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    timeoutMs: resolveLlmTimeoutMs(),
  });

  const db = new Database(resolvedDb);

  try {
    // Ensure staging table exists (idempotent)
    db.exec(`
      CREATE TABLE IF NOT EXISTS staging_materials (
        id TEXT PRIMARY KEY,
        cluster_id INTEGER NOT NULL,
        cluster_size INTEGER NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        nature TEXT,
        function_tag TEXT,
        knowledge_domain TEXT,
        source TEXT,
        confidence REAL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        similar_sentences_json TEXT NOT NULL DEFAULT '[]',
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_staging_materials_status ON staging_materials(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_materials_content_hash_unique ON staging_materials(content_hash);
    `);
    ensureOperationalTables(db);
    const stagingColumns = db.prepare('PRAGMA table_info(staging_materials)').all() as Array<{ name: string }>;
    const stagingColNames = new Set(stagingColumns.map(c => c.name));
    if (!stagingColNames.has('similar_sentences_json')) {
      db.exec(`ALTER TABLE staging_materials ADD COLUMN similar_sentences_json TEXT NOT NULL DEFAULT '[]'`);
    }

    // Read pending materials
    let query = `
      SELECT id, cluster_id, cluster_size, title, content, nature, function_tag, knowledge_domain,
             source, confidence, tags_json, COALESCE(similar_sentences_json, '[]') AS similar_sentences_json, source_refs_json
      FROM staging_materials
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `;
    if (maxMaterials && maxMaterials > 0) {
      query += ` LIMIT ${maxMaterials}`;
    }

    const rows = db.prepare(query).all() as StagingMaterialRow[];
    result.pendingMaterials = rows.length;

    if (rows.length === 0) {
      return result;
    }

    console.log(`Stage 2 aggregation: processing ${rows.length} pending materials...`);

    // Convert to materials
    const materials = rows.map(rowToMaterial);

    // Run LLM aggregation
    const aggregation = await aggregateKnowledgeMaterials(llm, materials);
    result.knowledgeProduced = aggregation.items.length;

    if (dryRun) {
      console.log(`[DRY RUN] Would produce ${aggregation.items.length} aggregated entries from ${rows.length} materials.`);
      for (const item of aggregation.items) {
        if (item.content && item.content.trim().length > 0) {
          const normalized = normalizeAggregatedItem(item);
          console.log(`  → [${normalized.nature ?? 'unknown'}] ${normalized.title}: ${normalized.content.slice(0, 60)}...`);
        }
      }
      return result;
    }

    // Write aggregated knowledge
    const provider = new SQLiteProvider({ dbPath: resolvedDb, configDir: dir });
    const repository = new KnowledgeRepository(provider);
    const consumedIds = new Set<string>();

    for (const item of aggregation.items) {
      if (!item.content || item.content.trim().length === 0) continue;

      const normalized = normalizeAggregatedItem(item);
      const now = new Date();
      const contentHash = createHash('sha256').update(normalized.content).digest('hex');

      const entry: KnowledgeEntry = {
        id: randomUUID(),
        type: normalized.legacyType,
        title: normalized.title,
        content: normalized.content,
        summary: normalized.content,
        source: {
          type: 'conversation',
          reference: `session-aggregate:${normalized.provenance.aggregationId}`,
          timestamp: now,
        },
        confidence: normalized.confidence,
        status: 'active',
        tags: normalized.tags,
        domain: normalized.domain,
        nature: normalized.nature,
        functionTag: normalized.functionTag,
        knowledgeDomain: normalized.domain,
        similarSentences: normalized.similarSentences,
        createdAt: now,
        updatedAt: now,
        version: 1,
        metadata: {
          domainData: {
            contentHash,
            staging: normalized.provenance,
          },
        },
      };

      try {
        const saved = await repository.save(entry, { skipQualityGate });
        if (saved) {
          result.knowledgeWritten++;
          for (const materialId of item.materialIds) consumedIds.add(materialId);
        }
      } catch (err) {
        result.errors.push(`Failed to save entry "${normalized.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Mark consumed materials
    const consumedAt = new Date().toISOString();
    const markConsumed = db.prepare(`UPDATE staging_materials SET status = 'consumed', consumed_at = ? WHERE id = ?`);

    for (const row of rows) {
      const hash = materialIdFromRow(row);
      if (consumedIds.has(hash)) {
        markConsumed.run(consumedAt, row.id);
        result.materialsConsumed++;
      }
    }

    await repository.close();
    result.reportId = randomUUID();
    db.prepare(`
      INSERT INTO governance_reports (id, type, payload_json, processed_count, status, created_at)
      VALUES (?, 'aggregation', ?, ?, ?, ?)
    `).run(
      result.reportId,
      JSON.stringify({
        pendingMaterials: result.pendingMaterials,
        knowledgeProduced: result.knowledgeProduced,
        knowledgeWritten: result.knowledgeWritten,
        materialsConsumed: result.materialsConsumed,
        errors: result.errors,
      }),
      result.knowledgeWritten,
      result.errors.length > 0 ? 'partial_failure' : 'completed',
      new Date().toISOString(),
    );
    console.log(`Stage 2 complete: ${result.knowledgeWritten} entries written, ${result.materialsConsumed} materials consumed.`);
  } catch (err) {
    result.errors.push(`Aggregation failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    db.close();
  }

  return result;
}

/**
 * Format aggregation result for CLI output.
 */
export function formatAggregatorResult(result: AggregatorResult, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(dryRun ? '=== Knowledge Aggregation (DRY RUN) ===' : '=== Knowledge Aggregation (Stage 2) ===');
  lines.push(`Pending materials:    ${result.pendingMaterials}`);
  lines.push(`Knowledge produced:   ${result.knowledgeProduced}`);
  if (!dryRun) {
    lines.push(`Knowledge written:    ${result.knowledgeWritten}`);
    lines.push(`Materials consumed:   ${result.materialsConsumed}`);
  }
  if (result.errors.length > 0) {
    lines.push(`\nErrors (${result.errors.length}):`);
    for (const e of result.errors) {
      lines.push(`  ✗ ${e}`);
    }
  }
  if (result.pendingMaterials === 0) {
    lines.push('\nNo pending staging materials. Run extract-sessions first to collect materials.');
  }
  return lines.join('\n');
}

/**
 * Alias for runKnowledgeAggregation — spec-compliant entry point (FR-FIX-02 AC3).
 */
export const aggregateFragments = runKnowledgeAggregation;
