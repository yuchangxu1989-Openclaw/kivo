/**
 * Session Knowledge LLM Extractor (FR-A05)
 *
 * Reads session-knowledge-candidates.json (produced by Python preprocessor),
 * sends each cluster's representative segments to an LLM for knowledge extraction,
 * and writes results to the KIVO DB with multi-dimensional tags (FR-B05).
 */

import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { resolveLlmConfig } from './resolve-llm-config.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';
import { KnowledgeRepository, SQLiteProvider } from '../repository/index.js';
import type { KnowledgeEntry, KnowledgeType, KnowledgeNature, KnowledgeFunction } from '../types/index.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface Segment {
  session_id: string;
  timestamp: string;
  text: string;
}

interface Cluster {
  cluster_id: number;
  cluster_size: number;
  representative_segments: Segment[];
}

interface CandidatesFile {
  metadata: {
    total_messages: number;
    total_segments: number;
    after_filter: number;
    generated_at: string;
    total_clusters: number;
  };
  clusters: Cluster[];
}

interface ExtractedItem {
  content: string;
  nature: string;
  function: string;
  domain: string;
  source: string;
  confidence: number;
  title?: string;
  tags?: string[];
}

export interface SessionExtractOptions {
  candidatesPath: string;
  dryRun?: boolean;
  limit?: number;
  since?: string;
  noQualityGate?: boolean;
}

export interface SessionExtractResult {
  clustersProcessed: number;
  clustersSkipped: number;
  knowledgeExtracted: number;
  knowledgeWritten: number;
  tokenEstimate: number;
  errors: string[];
}

// ── Nature → legacy type mapping ─────────────────────────────────────────────

const NATURE_TO_TYPE: Record<string, KnowledgeType> = {
  fact: 'fact',
  concept: 'fact',
  rule: 'intent',
  procedure: 'methodology',
  heuristic: 'experience',
};

const VALID_NATURES = new Set(['fact', 'concept', 'rule', 'procedure', 'heuristic']);
const VALID_FUNCTIONS = new Set(['routing', 'quality_gate', 'context_enrichment', 'decision_support', 'correction']);

function validateNature(v: string): KnowledgeNature | undefined {
  const n = (v ?? '').toLowerCase().trim();
  return VALID_NATURES.has(n) ? (n as KnowledgeNature) : undefined;
}

function validateFunction(v: string): KnowledgeFunction | undefined {
  const f = (v ?? '').toLowerCase().trim();
  return VALID_FUNCTIONS.has(f) ? (f as KnowledgeFunction) : undefined;
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildSessionExtractionPrompt(segments: Segment[]): string {
  const combined = segments
    .map(s => `[${s.timestamp}]\n${s.text}`)
    .join('\n\n---\n\n');

  return `从以下用户对话片段中提炼可复用的知识条目。

## 核心原则
你在做「知识提炼」，不是「对话摘要」。产出的是知识点，不是对话内容的总结。

## 格式约束（强制）
- title: 知识的「名字」，名词性短语，≤10字，名词性短语
- content: 知识的「定义/描述」，≤50字，简洁精炼
- 每个 cluster 最多提取 3 条，宁缺毋滥
- 没有可提炼的知识点就返回 []

## 正确示例
{"title":"展示页简洁原则","content":"公开页面用按钮跳GitHub，不写大段自我介绍"}
{"title":"理解错误时停下确认","content":"AI对概念理解有误时先停，等用户确认再操作"}
{"title":"禁止重复索要资源","content":"已提供过的图片/文件从历史上下文找，不再向用户要"}

## 错误示例（禁止）
✖ title:"产品展示页应简洁直接避免冗长介绍" ← 一句话，不是名称
✖ content:"用户对数据量有明确预期管理：之前已清理到400多条..." ← 对话摘要
✖ content:"用户偏好简洁直接的展示方式，反感冗长的自我介绍式文案" ← 第三人称摘要

## 提取重点
- 用户私有术语/黑话
- 纠偏规则（用户强调的约束）
- 决策及原因
- 方法论偏好
- 用户特有的指代和简写

## 过滤掉
- 纯操作性内容（帮我打开文件）
- 临时性对话（闲聊、确认收到）
- 配置片段（JSON/YAML）
- 系统提示词/铁律注入内容
- Agent 的工作笔记或总结

## 三维标签
1. nature: fact / concept / rule / procedure / heuristic
2. function: routing / quality_gate / context_enrichment / decision_support / correction
3. domain: 开放标签

## 输出格式
纯 JSON 数组：
{"content":"≤50字定义","title":"≤10字名词短语","nature":"<nature>","function":"<function>","domain":"<domain>","source":"session","confidence":0.0-1.0,"tags":["标签"]}

对话片段：
${combined}`;
}

// ── Parse LLM response ───────────────────────────────────────────────────────

function parseLlmResponse(raw: string): ExtractedItem[] {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).content === 'string' &&
        (item as Record<string, unknown>).content !== '',
    ) as ExtractedItem[];
  } catch {
    return [];
  }
}

// ── Estimate tokens ──────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  // Rough: 1 token ≈ 1.5 Chinese chars or 4 English chars
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

// ── Main extraction ──────────────────────────────────────────────────────────

export async function extractSessionKnowledge(
  options: SessionExtractOptions,
): Promise<SessionExtractResult> {
  const { candidatesPath, dryRun = false, limit, since, noQualityGate = false } = options;

  if (!existsSync(candidatesPath)) {
    throw new Error(`Candidates file not found: ${candidatesPath}`);
  }

  const raw = readFileSync(candidatesPath, 'utf-8');
  const candidates: CandidatesFile = JSON.parse(raw);

  // Resolve LLM config
  const llmConfig = resolveLlmConfig();
  if ('error' in llmConfig) {
    throw new Error(llmConfig.error);
  }

  const llm = new OpenAILLMProvider({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    timeoutMs: 120_000,
  });

  // Filter clusters
  let clusters = candidates.clusters;
  if (since) {
    const sinceDate = new Date(since);
    clusters = clusters.filter(c =>
      c.representative_segments.some(s => new Date(s.timestamp) >= sinceDate),
    );
  }
  if (limit !== undefined && limit > 0) {
    clusters = clusters.slice(0, limit);
  }

  // Resolve DB path
  const dir = process.cwd();
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = String(DEFAULT_CONFIG.dbPath);
  if (existsSync(configPath)) {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof cfg.dbPath === 'string') dbPath = cfg.dbPath;
  }
  const resolvedDb = resolve(dir, dbPath);

  const result: SessionExtractResult = {
    clustersProcessed: 0,
    clustersSkipped: 0,
    knowledgeExtracted: 0,
    knowledgeWritten: 0,
    tokenEstimate: 0,
    errors: [],
  };

  let db: Database.Database | null = null;
  let repository: KnowledgeRepository | null = null;
  if (!dryRun) {
    if (!existsSync(resolvedDb)) {
      throw new Error(`Database not found at ${resolvedDb}. Run "kivo init" first.`);
    }
    db = new Database(resolvedDb);
    // Ensure new columns exist
    const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
    const colNames = new Set(columns.map(c => c.name));
    if (!colNames.has('nature')) db.exec('ALTER TABLE entries ADD COLUMN nature TEXT');
    if (!colNames.has('function_tag')) db.exec('ALTER TABLE entries ADD COLUMN function_tag TEXT');
    if (!colNames.has('knowledge_domain')) db.exec('ALTER TABLE entries ADD COLUMN knowledge_domain TEXT');
    if (!colNames.has('content_hash')) {
      db.exec('ALTER TABLE entries ADD COLUMN content_hash TEXT');
      // Backfill content_hash for existing entries
      const allEntries = db.prepare('SELECT id, content FROM entries WHERE content_hash IS NULL').all() as Array<{ id: string; content: string }>;
      const updateHash = db.prepare('UPDATE entries SET content_hash = ? WHERE id = ?');
      for (const entry of allEntries) {
        const hash = createHash('sha256').update(entry.content).digest('hex');
        updateHash.run(hash, entry.id);
      }
      // Create index for fast dedup lookups (only active entries)
      db.exec('CREATE INDEX IF NOT EXISTS idx_entries_content_hash ON entries(content_hash) WHERE status = \'active\'');
    }

    // FR-A05 AC6: processed_sessions dedup tracking
    db.exec(`CREATE TABLE IF NOT EXISTS processed_sessions (
      session_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    )`);

    const provider = new SQLiteProvider({ dbPath: resolvedDb, configDir: dir });
    repository = new KnowledgeRepository(provider);
  }

  // Collect session processed_at timestamps for incremental dedup
  // Key change: track WHEN each session was last processed, not just IF it was processed.
  // A long-lived session gets new messages over time; we only skip segments older than processed_at.
  const sessionProcessedAt = new Map<string, string>();
  if (db) {
    const allSessionIds = new Set<string>();
    for (const cluster of clusters) {
      for (const seg of cluster.representative_segments) {
        if (seg.session_id) allSessionIds.add(seg.session_id);
      }
    }
    if (allSessionIds.size > 0) {
      const rows = db.prepare(
        `SELECT session_id, processed_at FROM processed_sessions WHERE session_id IN (${[...allSessionIds].map(() => '?').join(',')})`
      ).all(...allSessionIds) as Array<{ session_id: string; processed_at: string }>;
      for (const r of rows) sessionProcessedAt.set(r.session_id, r.processed_at);
    }
  }

  let consecutive403 = 0;

  for (const cluster of clusters) {
    const segments = cluster.representative_segments;
    if (segments.length === 0) {
      result.clustersSkipped++;
      continue;
    }

    // FR-A05 AC6: skip clusters where ALL segments are older than their session's processed_at
    if (!dryRun && sessionProcessedAt.size > 0) {
      const allSegmentsOld = segments.every(seg => {
        if (!seg.session_id || !seg.timestamp) return false;
        const processedAt = sessionProcessedAt.get(seg.session_id);
        if (!processedAt) return false; // session never processed → not old
        return seg.timestamp <= processedAt;
      });
      if (allSegmentsOld) {
        console.log(`Skipping cluster ${cluster.cluster_id}: all segments older than last processed_at`);
        result.clustersSkipped++;
        continue;
      }
    }

    const prompt = buildSessionExtractionPrompt(segments);
    result.tokenEstimate += estimateTokens(prompt);

    if (dryRun) {
      result.clustersProcessed++;
      // Estimate ~3 knowledge items per cluster for dry-run stats
      result.knowledgeExtracted += 3;
      continue;
    }

    try {
      console.log(`Processing cluster ${cluster.cluster_id} (${segments.length} segments)...`);
      const rawResponse = await llm.complete(prompt);
      consecutive403 = 0;
      const items = parseLlmResponse(rawResponse);
      result.knowledgeExtracted += items.length;
      result.clustersProcessed++;

      console.log(`  Extracted ${items.length} knowledge items from cluster ${cluster.cluster_id}`);

      // In-memory set for same-batch content dedup
      const batchHashes = new Set<string>();
      let clusterWritten = 0;

      for (const item of items) {
        if (clusterWritten >= 3) break; // Max 3 entries per cluster
        if (!item.content || item.content.trim().length < 5) continue;

        // Content hash dedup: skip if identical content already exists in DB or current batch
        const contentHash = createHash('sha256').update(item.content).digest('hex');
        if (batchHashes.has(contentHash)) {
          console.log(`  Skipping duplicate (same batch): ${item.content.slice(0, 50)}...`);
          continue;
        }
        const existingRow = db!.prepare(
          'SELECT id FROM entries WHERE content_hash = ? AND status = \'active\' LIMIT 1'
        ).get(contentHash) as { id: string } | undefined;
        if (existingRow) {
          console.log(`  Skipping duplicate (exists in DB): ${item.content.slice(0, 50)}...`);
          continue;
        }
        batchHashes.add(contentHash);

        const nature = validateNature(item.nature);
        const functionTag = validateFunction(item.function);
        const legacyType = nature ? (NATURE_TO_TYPE[nature] ?? 'fact') : 'fact';

        const id = randomUUID();
        const now = new Date();
        const tags = Array.isArray(item.tags) ? item.tags : [];
        const confidence = typeof item.confidence === 'number' ? Math.min(1, Math.max(0, item.confidence)) : 0.7;

        const entry: KnowledgeEntry = {
          id,
          type: legacyType,
          title: shortenKnowledgeTitle(item.title, item.content),
          content: item.content.slice(0, 50),
          summary: item.content.slice(0, 120),
          source: {
            type: 'conversation',
            reference: `session-extract:cluster-${cluster.cluster_id}`,
            timestamp: now,
          },
          confidence,
          status: 'active',
          tags,
          domain: item.domain || undefined,
          nature: nature || undefined,
          functionTag: functionTag || undefined,
          knowledgeDomain: item.domain || undefined,
          createdAt: now,
          updatedAt: now,
          version: 1,
          metadata: {
            domainData: {
              contentHash,
            },
          },
        };

        const saved = await repository!.save(entry, { skipQualityGate: noQualityGate });
        if (saved) {
          result.knowledgeWritten++;
          clusterWritten++;
        }
      }

      // FR-A05 AC6: update processed_at to the latest segment timestamp in this cluster
      // Use REPLACE to update existing entries with newer timestamps
      const latestTs = segments
        .map(s => s.timestamp)
        .filter(Boolean)
        .sort()
        .pop() || new Date().toISOString();
      const upsertProcessed = db!.prepare(
        'INSERT INTO processed_sessions (session_id, processed_at) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at WHERE excluded.processed_at > processed_sessions.processed_at'
      );
      for (const seg of segments) {
        if (seg.session_id) {
          upsertProcessed.run(seg.session_id, latestTs);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Cluster ${cluster.cluster_id}: ${errMsg}`);
      if (errMsg.includes('403')) {
        consecutive403++;
        if (consecutive403 >= 3) {
          result.errors.push('Aborting: 3 consecutive 403 errors. Check API key/provider.');
          break;
        }
      }
    }
  }

  if (db) {
    try { db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`); } catch { /* non-fatal */ }
    await repository?.close();
    db.close();
  }

  return result;
}
