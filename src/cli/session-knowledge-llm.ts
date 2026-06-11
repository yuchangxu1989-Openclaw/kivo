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
import { OpenAILLMProvider, resolveLlmTimeoutMs } from '../extraction/llm-extractor.js';
import { KnowledgeRepository, SQLiteProvider } from '../repository/index.js';
import { IntentRepository } from '../repository/intent-repository.js';
import { createEmbeddingProvider } from '../embedding/create-provider.js';
import type { EmbeddingProvider } from '../embedding/embedding-provider.js';
import {
  buildBehavioralChangeTestSection,
  buildHumanReadableIntentStyleSection,
  buildKnowledgeAdmissionBoundarySection,
} from '../standards/index.js';
import { aggregateKnowledgeMaterials, normalizeAggregatedItem, type KnowledgeMaterial } from './session-knowledge-aggregator.js';
import type { KnowledgeEntry, KnowledgeType, KnowledgeNature, KnowledgeFunction } from '../types/index.js';

// ── Extraction config (dedup threshold from shared admission-criteria) ───────

// ── Cosine similarity ────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface Segment {
  session_id: string;
  timestamp: string;
  text: string;
  message_ids?: string[];
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

export interface ExtractedItem {
  content: string;
  nature: string;
  function: string;
  domain: string;
  source: string;
  confidence: number;
  title?: string;
  tags?: string[];
  similar_sentences?: string[];
  similarSentences?: string[];
  why?: string;
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
  materialsCollected: number;
  knowledgeExtracted: number;
  knowledgeWritten: number;
  qualityGate?: import('./quality-auditor.js').QualityGateStats;
  postExtractionQuality?: import('./quality-auditor.js').PostExtractionQualityGovernanceReport;
  tokenEstimate: number;
  errors: string[];
}

// ── Nature → legacy type mapping ─────────────────────────────────────────────

export const NATURE_TO_TYPE: Record<string, KnowledgeType> = {
  fact: 'fact',
  decision: 'decision',
  methodology: 'methodology',
  experience: 'experience',
  intent: 'intent',
  meta: 'meta',
};

const VALID_NATURES = new Set(['fact', 'decision', 'methodology', 'experience', 'intent', 'meta']);
const VALID_FUNCTIONS = new Set(['constraint', 'preference', 'pattern', 'principle']);

export function validateNature(v: string): KnowledgeNature | undefined {
  const n = (v ?? '').toLowerCase().trim();
  return VALID_NATURES.has(n) ? (n as KnowledgeNature) : undefined;
}

export function validateFunction(v: string): KnowledgeFunction | undefined {
  const f = (v ?? '').toLowerCase().trim();
  return VALID_FUNCTIONS.has(f) ? (f as KnowledgeFunction) : undefined;
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export function buildSessionExtractionPrompt(segments: Segment[]): string {
  const combined = segments
    .map(s => `[${s.timestamp}]\n${s.text}`)
    .join('\n\n---\n\n');

  return `从以下用户对话片段中收集可用于知识萃取的素材。

## 核心原则
你在做「Stage 1 素材采集」，不是「最终知识入库」。每条输出只是候选素材（staging material），会先写入 staging 区域；后续 Stage 2 会把同主题素材做 LLM 语义聚类和抽象聚合，只有聚合后的长效知识才允许进入知识库。

${buildKnowledgeAdmissionBoundarySection()}

### 第一步：去上下文化
- 解析所有代词和指代："这个" → 具体指代什么；"上面那个" → 具体是什么
- 素材必须脱离对话上下文后仍然可理解（自包含）
- 禁止出现"用户说""AI回复"等对话角色描述

${buildBehavioralChangeTestSection()}

// LOCKED: 准入标准变更需用户(于长煦)明确批准
## 三重测试准入门禁（每条素材必须全部通过，任一不通过直接丢弃）

对每条候选素材逐一执行以下三个测试：

### 测试 1：时效性测试
问：「三个月后这条信息还有效吗？」
- 通过：长期有效的原则、方法论、理解模型
- 不通过：临时状态、一次性决策、排查中间步骤、当前配置、待办事项、本周/今天的安排

### 测试 2：跨场景测试
问：「换一个完全不同的项目/团队/场景，它还适用吗？」
- 通过：不绑定特定项目、特定时间窗口、特定人员的通用洞察
- 不通过：绑定特定项目的决策、特定 agent 的调度、特定时间窗口的优先级

### 测试 3：抽象性测试
问：「去掉具体的人名、项目名、时间，它是否仍有指导价值？」
- 通过：经过抽象聚合的理解模型、可复用原则
- 不通过：未经抽象的原始事件记录、具体操作指令、行为约束/铁律的原文搬运

三重测试必须由你（LLM）语义判断执行。禁止用关键词匹配、正则、FTS5 或规则引擎承担语义理解职责。

## 素材采集方向（强制参考）
- 只采集有机会被 Stage 2 抽象成长期机制的素材。
- 三重测试全部通过，才采集。任一不通过，直接丢弃。
- 每条素材最终必须能支撑回答：它让 agent 在什么场景下避免什么错误。
- 行为约束/铁律/系统 prompt 注入内容不是知识素材——它们是指令，不是理解模型。
- 任务派发指令、一次性调度安排、排查步骤记录、临时优先级决策、具体文件路径、命令行、配置片段，全部禁止采集。
- 如果素材表达用户偏好、行为模式、意图映射或研发流程期望，nature 输出 "intent"，后续会进入独立意图库。
- 语义判断只能由 LLM 完成，禁止把关键词匹配、正则、FTS5 或规则引擎当作知识判断方法。

${buildHumanReadableIntentStyleSection()}

## 术语识别（FR-H05 补充采集）
除上述素材外，当对话中出现专有名词/术语定义时，额外提取为术语条目。术语条目不受三重测试约束（术语本身是长期有效的事实）。
识别模式：
- 「X 是/叫/指/代表/全称是/缩写是 Y」
- 「X（Y）」格式的括号解释
- 「X，即 Y」「X，也就是 Y」
- 对产品名、项目名、团队内部术语的首次解释

术语条目输出要求：
- nature: "fact"
- domain: "system-dictionary"
- title: 术语名本身
- content: 完整定义
- confidence >= 0.7

## 正例（通过三重测试的素材）
{"title":"用向量检索代替正则做语义判断","content":"涉及意图、分类、路由和知识判断时，要使用 LLM 或向量检索承担语义理解；关键词和正则只能提取结构化格式，不能判断语义。","why":"用规则冒充语义理解缺乏泛化能力，曾导致分类误判和系统长时间瘫痪。","nature":"intent"}
{"title":"修问题先堵根因再处理表面症状","content":"修复问题时先定位并堵住根因，再处理表面症状；否则同样的异常会在后续任务里反复出现。","why":"只治表面会让同一类 bug 反复返工，浪费排查和验证时间。","nature":"methodology"}
{"title":"展示页用按钮让用户直接进入详情","content":"公开页面要让用户快速看到下一步入口，用按钮跳转详情，不用大段自我介绍占据首屏。","why":"用户扫一眼就走，大段文字会稀释行动入口并提高跳出率。","nature":"intent"}
{"title":"理解错用户意图时先停下来确认","content":"AI 发现自己对概念或需求理解有误时，应先暂停并请用户确认，再继续拆任务或写代码。","why":"带着错误理解推进会把后续计划和实现全部带偏，最终只能整体返工。","nature":"experience"}
{"title":"系统设计不需要无 LLM 降级路径","content":"当系统约定 LLM 始终可用时，语义理解链路不需要设计无 LLM 的规则降级路径。","why":"为不存在的无 LLM 场景设计降级，会把语义判断重新拉回关键词或规则误判。","nature":"intent"}
{"title":"同一方法失败两次后必须换策略","content":"连续两次用同一方法失败后，要换诊断或实现策略，而不是原样重试第三次。","why":"原样重试只会消耗时间和上下文，不会带来新信息。","nature":"methodology"}

## 负例（不通过三重测试，禁止采集）
✖ content:"今天先派 cc 修 KIVO，codex 做 AEO" ← 一次性调度决策（时效性不通过）
✖ content:"P0级bug修复不需要请示用户，直接修复" ← 行为铁律/操作规则（抽象性不通过，是指令不是知识）
✖ content:"把这个任务派给 dev-01" ← 任务派发指令（跨场景不通过）
✖ content:"这周 KIVO 优先级高于 AEO" ← 临时优先级排序（时效性不通过）
✖ content:"刚才 openclaw doctor 报错，加日志定位根因" ← 排查中间步骤（时效性不通过）
✖ content:"用户让 agent 读取任务看板再派发" ← 任务派发指令（跨场景不通过）
✖ content:"禁止主会话执行超过30秒的命令" ← 行为约束/铁律原文搬运（抽象性不通过，是指令不是理解模型）
✖ content:"SEVO 拦截不可绕过" ← 系统规则/铁律（抽象性不通过，是指令不是知识）
✖ content:"src/cli/session-knowledge-llm.ts 要修改" ← 具体文件路径（跨场景不通过）
✖ content:"执行 systemctl --user restart kivo-web" ← 命令行操作（抽象性不通过）
✖ content:"当前用 penguin provider，agent 池有 12 个" ← 配置描述（时效性不通过）
✖ content:"需要加个监控脚本" ← 待办事项（时效性不通过）
✖ content:"今天 cc 超时了三次" ← 未经抽象的事件记录（抽象性不通过）
✖ content:"LLM 是大语言模型的缩写" ← 通用常识（行为变化测试不通过）

## 格式约束（强制）
- title/content/why/similar_sentences 统一遵守上方「人话意图写作标准」。
- 没有通过三重测试的内容就返回 []

## 三维标签
1. nature: fact / decision / methodology / experience / intent / meta
2. function: constraint / preference / pattern / principle
3. domain: 开放标签

## 输出格式
纯 JSON 数组：
{"content":"具体场景下该做什么，不做会造成什么后果","why":"不这样做的后果、踩坑代价或失败模式；必须填写，无法可靠推断就丢弃该条","title":"提取知识时标题要像人说话一样具体","nature":"<nature>","function":"<function>","domain":"<domain>","source":"session-material","confidence":0.0-1.0,"tags":["标签"],"similar_sentences":["泛化表述1","泛化表述2"]}

对话片段：
${combined}`;
}

function normalizeMessageIds(segment: Segment): string[] {
  return Array.isArray(segment.message_ids)
    ? segment.message_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
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
  why: string | null;
}

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

function normalizeWhy(raw: string | undefined, content: string): string | undefined {
  const why = raw?.trim() ?? '';
  if (!why || why === '待补充') return undefined;
  const normalizedWhy = why.replace(/\s+/g, ' ');
  const normalizedContent = content.trim().replace(/\s+/g, ' ');
  return normalizedWhy === normalizedContent ? undefined : why;
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
    why: normalizeWhy(row.why ?? undefined, row.content),
    sourceRefs: parseJsonArray(row.source_refs_json).map(v => {
      const ref = v as { sessionId?: unknown; timestamp?: unknown };
      return {
        sessionId: typeof ref.sessionId === 'string' ? ref.sessionId : '',
        timestamp: typeof ref.timestamp === 'string' ? ref.timestamp : '',
      };
    }),
  };
}

async function buildIntentEmbedding(
  embedder: EmbeddingProvider,
  item: ReturnType<typeof normalizeAggregatedItem>,
): Promise<number[] | null> {
  try {
    const text = [
      item.title,
      item.content,
      item.why ?? '',
      ...(item.similarSentences ?? []),
    ].filter(Boolean).join('\n');
    return await embedder.embed(text);
  } catch {
    return null;
  }
}

async function persistAggregatedIntent(
  repository: IntentRepository,
  embedder: EmbeddingProvider,
  item: ReturnType<typeof normalizeAggregatedItem>,
): Promise<boolean> {
  const firstSourceRef = Array.isArray(item.provenance.sourceRefs)
    ? item.provenance.sourceRefs.find((sourceRef) => {
        const candidate = sourceRef as { sessionId?: unknown };
        return typeof candidate.sessionId === 'string' && candidate.sessionId.trim().length > 0;
      }) as { sessionId?: string } | undefined
    : undefined;

  const embedding = await buildIntentEmbedding(embedder, item);
  repository.upsert({
    name: item.title,
    description: item.content,
    why: item.why,
    similarSentences: item.similarSentences,
    status: 'active',
    confidence: item.confidence,
    sourceSessionId: firstSourceRef?.sessionId,
    embedding,
  });
  return true;
}

async function runStage2Aggregation(
  db: Database.Database,
  repository: KnowledgeRepository,
  llm: OpenAILLMProvider,
  noQualityGate: boolean,
): Promise<number> {
  const rows = db.prepare(`
    SELECT id, cluster_id, cluster_size, title, content, why, nature, function_tag, knowledge_domain,
           source, confidence, tags_json, COALESCE(similar_sentences_json, '[]') AS similar_sentences_json, source_refs_json
    FROM staging_materials
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `).all() as StagingMaterialRow[];

  if (rows.length === 0) return 0;

  const materials = rows.map(rowToMaterial);
  const aggregation = await aggregateKnowledgeMaterials(llm, materials);
  const intentRepository = new IntentRepository(db);
  const intentEmbedder = createEmbeddingProvider();
  let written = 0;
  const consumedIds = new Set<string>();

  for (const item of aggregation.items) {
    if (!item.content || item.content.trim().length === 0) continue;
    const normalized = normalizeAggregatedItem(item);
    if (normalized.legacyType === 'intent') {
      const saved = await persistAggregatedIntent(intentRepository, intentEmbedder, normalized);
      if (saved) {
        written++;
        for (const materialId of item.materialIds) consumedIds.add(materialId);
      }
      continue;
    }

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
      why: normalized.why,
      createdAt: now,
      updatedAt: now,
      version: 1,
      metadata: {
        domainData: {
          contentHash,
          ...(normalized.why ? { why: normalized.why } : {}),
          staging: normalized.provenance,
        },
      },
    };

    const saved = await repository.save(entry, { skipQualityGate: noQualityGate });
    if (saved) {
      written++;
      for (const materialId of item.materialIds) consumedIds.add(materialId);
    }
  }

  const consumedAt = new Date().toISOString();
  const markConsumed = db.prepare(`UPDATE staging_materials SET status = 'consumed', consumed_at = ? WHERE id = ?`);
  for (const row of rows) {
    const materialHash = createHash('sha256')
      .update(`${row.cluster_id}:${row.content}`)
      .digest('hex')
      .slice(0, 16);
    if (consumedIds.has(materialHash)) markConsumed.run(consumedAt, row.id);
  }

  return written;
}

// ── Parse LLM response ───────────────────────────────────────────────────────

export function parseLlmResponse(raw: string): ExtractedItem[] {
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

export function estimateTokens(text: string): number {
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
    timeoutMs: resolveLlmTimeoutMs(),
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
    materialsCollected: 0,
    knowledgeExtracted: 0,
    knowledgeWritten: 0,
    tokenEstimate: 0,
    errors: [],
  };

  let db: Database.Database | null = null;
  let repository: KnowledgeRepository | null = null;
  const qualityGateStartedAt = new Date().toISOString();
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

    if (noQualityGate) {
      console.warn('⚠ --no-quality-gate enabled: FR-N05 quality gate is bypassed for session extraction. Use only for debugging/migration.');
    }

    // FR-A05: staging area for Stage 1 materials. Stage 1 never writes directly to entries.
    db.exec(`
      CREATE TABLE IF NOT EXISTS staging_materials (
        id TEXT PRIMARY KEY,
        cluster_id INTEGER NOT NULL,
        cluster_size INTEGER NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        why TEXT,
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_materials_content_hash_unique ON staging_materials(content_hash)
    `);
    const stagingColumns = db.prepare('PRAGMA table_info(staging_materials)').all() as Array<{ name: string }>;
    const stagingColNames = new Set(stagingColumns.map(c => c.name));
    if (!stagingColNames.has('similar_sentences_json')) {
      db.exec(`ALTER TABLE staging_materials ADD COLUMN similar_sentences_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!stagingColNames.has('why')) {
      db.exec(`ALTER TABLE staging_materials ADD COLUMN why TEXT`);
    }
    // FR-A05 AC6: processed_sessions dedup tracking
    db.exec(`CREATE TABLE IF NOT EXISTS processed_sessions (
      session_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS realtime_processed_messages (
      message_id TEXT PRIMARY KEY,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'processed',
      processed_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'kivo-intent-injection'
    )`);

    const provider = new SQLiteProvider({ dbPath: resolvedDb, configDir: dir });
    repository = new KnowledgeRepository(provider);
  }

  // Collect session processed_at timestamps for incremental dedup
  // Key change: track WHEN each session was last processed, not just IF it was processed.
  // A long-lived session gets new messages over time; we only skip segments older than processed_at.
  const sessionProcessedAt = new Map<string, string>();
  const realtimeProcessedMessageIds = new Set<string>();
  if (db) {
    const allSessionIds = new Set<string>();
    const allMessageIds = new Set<string>();
    for (const cluster of clusters) {
      for (const seg of cluster.representative_segments) {
        if (seg.session_id) allSessionIds.add(seg.session_id);
        for (const messageId of normalizeMessageIds(seg)) {
          allMessageIds.add(messageId);
        }
      }
    }
    if (allSessionIds.size > 0) {
      const rows = db.prepare(
        `SELECT session_id, processed_at FROM processed_sessions WHERE session_id IN (${[...allSessionIds].map(() => '?').join(',')})`
      ).all(...allSessionIds) as Array<{ session_id: string; processed_at: string }>;
      for (const r of rows) sessionProcessedAt.set(r.session_id, r.processed_at);
    }
    if (allMessageIds.size > 0) {
      const rows = db.prepare(
        `SELECT message_id FROM realtime_processed_messages WHERE message_id IN (${[...allMessageIds].map(() => '?').join(',')})`
      ).all(...allMessageIds) as Array<{ message_id: string }>;
      for (const row of rows) realtimeProcessedMessageIds.add(row.message_id);
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
    if (!dryRun && segments.length > 0) {
      const allSegmentsRealtimeProcessed = segments.every((seg) => {
        const messageIds = normalizeMessageIds(seg);
        return messageIds.length > 0 && messageIds.every((messageId) => realtimeProcessedMessageIds.has(messageId));
      });
      if (allSegmentsRealtimeProcessed) {
        console.log(`Skipping cluster ${cluster.cluster_id}: all segments already handled by realtime extraction`);
        result.clustersSkipped++;
        continue;
      }
    }

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
      // Dry-run only counts clusters and token estimate; it does not invent material counts.

      continue;
    }

    try {
      console.log(`Processing cluster ${cluster.cluster_id} (${segments.length} segments)...`);
      const rawResponse = await llm.complete(prompt);
      consecutive403 = 0;
      const items = parseLlmResponse(rawResponse);
      result.knowledgeExtracted += items.length;
      result.clustersProcessed++;

      console.log(`  Collected ${items.length} staging materials from cluster ${cluster.cluster_id}`);

      const insertStagingMaterial = db!.prepare(`
        INSERT INTO staging_materials (
          id, cluster_id, cluster_size, title, content, why, nature, function_tag, knowledge_domain,
          source, confidence, tags_json, similar_sentences_json, source_refs_json, content_hash, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(content_hash) DO NOTHING
      `);
      const sourceRefs = segments
        .filter(seg => seg.session_id || seg.timestamp)
        .map(seg => ({ sessionId: seg.session_id, timestamp: seg.timestamp }));
      const nowIso = new Date().toISOString();
      for (const item of items) {
        if (!item.content || item.content.trim().length === 0) continue;
        const content = item.content.trim();
        const contentHash = createHash('sha256').update(content).digest('hex');
        const info = insertStagingMaterial.run(
          randomUUID(),
          cluster.cluster_id,
          cluster.cluster_size,
          item.title ?? null,
          content,
          normalizeWhy(item.why, content) ?? null,
          item.nature ?? null,
          item.function ?? null,
          item.domain ?? null,
          item.source ?? 'session-material',
          typeof item.confidence === 'number' ? Math.min(1, Math.max(0, item.confidence)) : null,
          JSON.stringify(Array.isArray(item.tags) ? item.tags : []),
          JSON.stringify(Array.isArray(item.similar_sentences)
            ? item.similar_sentences.slice(0, 3)
            : Array.isArray(item.similarSentences)
              ? item.similarSentences.slice(0, 3)
              : []),
          JSON.stringify(sourceRefs),
          contentHash,
          nowIso,
        );
        if (info.changes > 0) result.materialsCollected++;
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

  if (db && repository) {
    try {
      const written = await runStage2Aggregation(db, repository, llm, noQualityGate);
      result.knowledgeWritten += written;
      if (written > 0) console.log(`Stage 2 aggregation wrote ${written} knowledge entries.`);

      const { buildGateStatsFromQualityLog, runPostExtractionQualityGovernance } = await import('./quality-auditor.js');
      result.qualityGate = buildGateStatsFromQualityLog(
        db,
        qualityGateStartedAt,
        Number.parseFloat(process.env.KIVO_EXTRACT_GATE_REJECT_WARN_THRESHOLD ?? '0.8'),
      );
      console.log(`Quality gate: total=${result.qualityGate.total}, passed=${result.qualityGate.passed}, rejected=${result.qualityGate.rejected}, merged=${result.qualityGate.merged}, bypassed=${result.qualityGate.bypassed}`);
      if (result.qualityGate.warning) console.warn(`⚠ ${result.qualityGate.warning}`);

      if (process.env.KIVO_EXTRACT_POST_QUALITY_AUDIT !== '0' && !noQualityGate) {
        result.postExtractionQuality = await runPostExtractionQualityGovernance({
          db,
          sinceIso: qualityGateStartedAt,
          threshold: Number.parseInt(process.env.KIVO_EXTRACT_QUALITY_THRESHOLD ?? '2', 10),
          limit: Number.parseInt(process.env.KIVO_EXTRACT_QUALITY_BATCH_SIZE ?? '50', 10),
        });
        console.log(`Post-extraction quality audit: assessed=${result.postExtractionQuality.assessed}, quarantined=${result.postExtractionQuality.quarantined}, evidence=${result.postExtractionQuality.evidencePreserved}`);
        for (const error of result.postExtractionQuality.errors) result.errors.push(`Post-extraction quality audit: ${error}`);
      }
    } catch (err) {
      result.errors.push(`Stage 2 aggregation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (db) {
    try { db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`); } catch { /* non-fatal */ }
    await repository?.close();
    db.close();
  }

  return result;
}
