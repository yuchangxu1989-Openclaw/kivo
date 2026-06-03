/**
 * SubjectClassifier — KIVO Wave 1 / A2
 *
 * 按 SubjectClassifier 技术设计文档实现：
 *   1. 向量检索 bge-m3 找候选 subject_nodes
 *   2. LLM rerank 确定最终归属 + confidence
 *   3. threshold 分流：≥ 0.7 → classified, < 0.7 → pending_review
 *
 * 禁止关键词匹配 / FTS5 / 正则冒充语义理解（N-L01）。
 * 必须用向量检索 + LLM。
 *
 * spec: FR-B03 / arc42 §5.3.1
 */

import type Database from 'better-sqlite3';
import { openWebDb } from '@/lib/db';
import { embed, embedBatch } from '@/lib/embedding-client';
import { chatJson, LlmClientError } from '@/lib/llm/penguin-client';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClassifyInput {
  materialId: string;
  /** 文本主体 / OCR / ASR 拼接 */
  content: string;
  contentSummary?: string;
  language?: 'zh' | 'en' | 'mixed';
}

export interface ClassificationResult {
  subjectDomain: string;
  subjectNodeId: string | null;
  classificationStatus: 'auto_assigned' | 'pending' | 'extract_failed';
  confidence: number;
  isNewDomain: boolean;
  suggestedPath: string[];
  reasoning: string;
  meta: {
    model: string;
    promptVersion: string;
    latencyMs: number;
    truncated: boolean;
    cacheHit: boolean;
    error?: string;
  };
}

interface SubjectNodeRow {
  id: string;
  name: string;
  parent_id: string | null;
  level: number;
  merged_into: string | null;
}

interface SubjectWithEmbedding {
  id: string;
  name: string;
  parentId: string | null;
  level: number;
  parentName: string | null;
  similarity: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const CONFIDENCE_THRESHOLD = Number(
  process.env.KIVO_CLASSIFY_THRESHOLD || 0.7,
);

const PROMPT_VERSION = 'subject-classifier-v1';
const MAX_CONTENT_EXCERPT = 2400;
const MAX_SUBJECT_TREE_NODES = 30;
const VECTOR_TOP_K = 10;
const VECTOR_MIN_SCORE = 0.2;
const CLASSIFY_LLM_MODEL =
  process.env.KIVO_CLASSIFY_LLM_MODEL ||
  process.env.KIVO_LLM_MODEL ||
  'gpt-5.5';

// ─── Embedding helpers ───────────────────────────────────────────────────────

/**
 * Embed text via shared embedding-client (fallback chain across remote
 * OpenAI-compatible / local ollama / local BGE service).
 */
async function embedText(text: string): Promise<number[]> {
  const result = await embed(text);
  return result.embedding;
}

function cosineSimilarity(a: number[], b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i] as number;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Subject tree loading ────────────────────────────────────────────────────

function loadAllSubjectNodes(db: Database.Database): SubjectNodeRow[] {
  return db
    .prepare(
      `SELECT id, name, parent_id, level, merged_into
         FROM subject_nodes
        WHERE merged_into IS NULL
        ORDER BY level ASC, name ASC`,
    )
    .all() as SubjectNodeRow[];
}

/**
 * 向量检索：把 material content 嵌入后，与所有 subject_node 名称的嵌入做
 * cosine similarity，取 top-K 作为候选。
 *
 * 注意：subject_nodes 表没有 embedding 列，我们对 node name 做实时嵌入。
 * 节点数通常 < 100，实时嵌入可接受。如果节点数增长，后续可加缓存列。
 */
async function vectorSearchSubjects(
  contentEmbedding: number[],
  nodes: SubjectNodeRow[],
  db: Database.Database,
): Promise<SubjectWithEmbedding[]> {
  if (nodes.length === 0) return [];

  // Build name → parent lookup
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Batch embed all node names (concatenate name + parent for context)
  const nodeTexts = nodes.map((n) => {
    const parent = n.parent_id ? nodeMap.get(n.parent_id) : null;
    return parent ? `${parent.name} / ${n.name}` : n.name;
  });

  // Embed all node names in one batch call
  const nodeEmbeddings = await batchEmbedTexts(nodeTexts);

  // Compute similarities，按 subject_id 聚合最高分
  const bestById = new Map<string, SubjectWithEmbedding>();
  const upsert = (candidate: SubjectWithEmbedding) => {
    const cur = bestById.get(candidate.id);
    if (!cur || candidate.similarity > cur.similarity) {
      bestById.set(candidate.id, candidate);
    }
  };

  for (let i = 0; i < nodes.length; i++) {
    const emb = nodeEmbeddings[i];
    if (!emb) continue;
    const sim = cosineSimilarity(contentEmbedding, emb);
    if (sim >= VECTOR_MIN_SCORE) {
      const node = nodes[i];
      const parent = node.parent_id ? nodeMap.get(node.parent_id) : null;
      upsert({
        id: node.id,
        name: node.name,
        parentId: node.parent_id,
        level: node.level,
        parentName: parent?.name ?? null,
        similarity: sim,
      });
    }
  }

  // FR-B03 AC7：把 subject_aliases.alias_embedding 也合并到候选集，
  // 让重命名 / merge 历史名也能命中分类。
  const aliasRows = db
    .prepare(
      `SELECT subject_id, alias_embedding
         FROM subject_aliases
        WHERE alias_embedding IS NOT NULL`,
    )
    .all() as Array<{ subject_id: string; alias_embedding: Buffer | null }>;

  for (const row of aliasRows) {
    if (!row.alias_embedding || row.alias_embedding.byteLength % 4 !== 0) continue;
    const node = nodeMap.get(row.subject_id);
    if (!node) continue; // 已被 merged_into 的别名不参与
    const arr = new Float32Array(
      row.alias_embedding.buffer,
      row.alias_embedding.byteOffset,
      row.alias_embedding.byteLength / 4,
    );
    if (arr.length !== contentEmbedding.length) continue;
    const sim = cosineSimilarity(contentEmbedding, arr);
    if (sim >= VECTOR_MIN_SCORE) {
      const parent = node.parent_id ? nodeMap.get(node.parent_id) : null;
      upsert({
        id: node.id,
        name: node.name,
        parentId: node.parent_id,
        level: node.level,
        parentName: parent?.name ?? null,
        similarity: sim,
      });
    }
  }

  const scored = Array.from(bestById.values());
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, VECTOR_TOP_K);
}

/**
 * Batch embed multiple texts via shared embedding-client (fallback chain).
 */
async function batchEmbedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { embeddings } = await embedBatch(texts);
  return embeddings;
}

// ─── Content truncation ──────────────────────────────────────────────────────

function truncateContent(input: ClassifyInput): {
  excerpt: string;
  truncated: boolean;
} {
  const content = input.content || '';
  if (content.length <= MAX_CONTENT_EXCERPT) {
    return { excerpt: content, truncated: false };
  }

  // Head + summary + tail strategy per design doc
  const head = content.slice(0, 1500);
  const tail = content.slice(-300);
  const summary = input.contentSummary?.slice(0, 400) || '';

  const parts: string[] = [];
  parts.push(`[开头]\n${head}`);
  if (summary) parts.push(`[摘要]\n${summary}`);
  parts.push(`[结尾]\n${tail}`);

  const excerpt = parts.join('\n\n').slice(0, MAX_CONTENT_EXCERPT);
  return { excerpt, truncated: true };
}

// ─── Subject tree text rendering ─────────────────────────────────────────────

function renderSubjectTreeText(nodes: SubjectNodeRow[]): string {
  if (nodes.length === 0) return '(暂无已有学科域，本系统初始状态)';

  // Group by root (level=0)
  const roots = nodes.filter((n) => n.level === 0 || !n.parent_id);
  const childMap = new Map<string, SubjectNodeRow[]>();
  for (const n of nodes) {
    if (n.parent_id) {
      const arr = childMap.get(n.parent_id) || [];
      arr.push(n);
      childMap.set(n.parent_id, arr);
    }
  }

  const lines: string[] = [];
  const displayRoots = roots.slice(0, MAX_SUBJECT_TREE_NODES);
  for (const root of displayRoots) {
    const children = (childMap.get(root.id) || []).slice(0, 5);
    const childNames = children.map((c) => c.name);
    lines.push(`- ${root.name} / [${childNames.join(', ')}]`);
  }

  if (roots.length > MAX_SUBJECT_TREE_NODES) {
    lines.push(`…(其余 ${roots.length - MAX_SUBJECT_TREE_NODES} 个根节点已省略)`);
  }

  return lines.join('\n');
}

// ─── LLM Rerank Prompt ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是 KIVO 知识基座的主题域分类专家。

你的任务：根据用户提供的 Material 内容，判断它归属于哪个主题域，并产出严格 JSON 结果。

主题域覆盖一切由 KIVO 自动分类的内容主题，可以是某类资料、某个项目、某组流程、某段经验或某套规则。不要把分类限制在任何特定行业或学科。

判断规则：
1. 优先匹配「已有主题树」中的现有节点；若 Material 内容明确归属某根节点或二级节点，必须返回现有节点的精确名称，并将 is_new_domain 设为 false。
2. 如内容明显不属于任何已有节点，给出新主题域名称建议（中文，长度 ≤ 12 字，避免英文术语），将 is_new_domain 设为 true。
3. 如建议层级路径（subject_path），按 [根节点, 二级节点, 三级节点] 格式输出，最多三级；只有把握时再给出二级 / 三级，否则只填根节点。
4. confidence 反映你判断的可信度：内容主题清晰且与某节点高度对应给 ≥ 0.85；存在多种可能但仍能给出主导判断给 0.7~0.85；模棱两可、缺乏关键线索给 < 0.7。
5. reasoning 用一句话（≤ 60 字）说明判断依据，用户会在待确认队列里看到。
6. 内容明显涉及多个主题（占比相近）时，优先选择主导主题，并在 reasoning 里点明「混杂多主题：A / B」，由 slice 级再细分。

输出格式：仅返回单个 JSON 对象，不要任何额外文字、解释、markdown 代码围栏：
{
  "subject_domain": string,
  "is_new_domain": boolean,
  "subject_path": string[],
  "confidence": number,
  "reasoning": string
}

例 1（明确归位，已有节点 ['核心概念']）：
输入摘要：「某个核心概念的定义、适用边界与常见判断条件」
输出：{"subject_domain":"核心概念","is_new_domain":false,"subject_path":["核心概念","适用边界"],"confidence":0.92,"reasoning":"内容围绕概念定义和边界，归位现有节点"}

例 2（多主题混杂，已有节点 ['用户反馈','流程设计']）：
输入摘要：「访谈记录中同时出现使用困惑、页面流程截图与操作步骤拆解」
输出：{"subject_domain":"用户反馈","is_new_domain":false,"subject_path":["用户反馈","访谈记录"],"confidence":0.74,"reasoning":"主导是用户反馈，混杂多主题：用户反馈/流程设计"}

例 3（全新主题建议，已有节点 ['核心概念','执行记录']）：
输入摘要：「记录一套周期性复盘办法和每次复盘后的改进动作」
输出：{"subject_domain":"复盘机制","is_new_domain":true,"subject_path":["复盘机制","改进动作"],"confidence":0.81,"reasoning":"主题与既有节点无重合，建议新建复盘机制根节点"}`;

function buildUserPrompt(
  materialId: string,
  excerpt: string,
  subjectTreeText: string,
  language: string,
  vectorCandidates: SubjectWithEmbedding[],
): string {
  const candidateBlock = vectorCandidates.length > 0
    ? vectorCandidates
        .map(
          (c) =>
            `  - id="${c.id}" name="${c.name}" similarity=${c.similarity.toFixed(3)}${c.parentName ? ` (父域: ${c.parentName})` : ''}`,
        )
        .join('\n')
    : '  (无向量检索命中)';

  return `【已有学科树】
${subjectTreeText}

【向量检索候选（bge-m3 相似度 top-${VECTOR_TOP_K}）】
${candidateBlock}

【Material 摘要】
material_id: ${materialId}
language: ${language}
content_excerpt:
${excerpt}

请按 system prompt 要求输出 JSON。`;
}

// ─── LLM output validation ──────────────────────────────────────────────────

interface LlmOutput {
  subject_domain: string;
  is_new_domain: boolean;
  subject_path: string[];
  confidence: number;
  reasoning: string;
}

function validateLlmOutput(raw: unknown): LlmOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const domain = obj.subject_domain;
  if (typeof domain !== 'string' || domain.length === 0 || domain.length > 24)
    return null;

  const isNew = obj.is_new_domain;
  if (typeof isNew !== 'boolean') return null;

  const path = obj.subject_path;
  if (!Array.isArray(path) || path.length === 0 || path.length > 3) return null;
  if (!path.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 24))
    return null;

  const confidence = obj.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;

  const reasoning = obj.reasoning;
  if (typeof reasoning !== 'string') return null;

  return {
    subject_domain: domain,
    is_new_domain: isNew,
    subject_path: path,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasoning: reasoning.slice(0, 120),
  };
}

// ─── Subject node resolution ─────────────────────────────────────────────────

function resolveSubjectNodeId(
  llmOutput: LlmOutput,
  nodes: SubjectNodeRow[],
  vectorCandidates: SubjectWithEmbedding[],
): string | null {
  if (llmOutput.is_new_domain) return null;

  // Try exact name match first
  const exactMatch = nodes.find(
    (n) => n.name === llmOutput.subject_domain,
  );
  if (exactMatch) return exactMatch.id;

  // Try path[0] match
  const pathMatch = nodes.find(
    (n) => n.name === llmOutput.subject_path[0],
  );
  if (pathMatch) return pathMatch.id;

  // Fall back to highest-similarity vector candidate
  if (vectorCandidates.length > 0) {
    return vectorCandidates[0].id;
  }

  return null;
}

// ─── Main classify function ──────────────────────────────────────────────────

/**
 * SubjectClassifier 主入口。
 *
 * 流程：
 *   1. 截取 content → excerpt
 *   2. 嵌入 excerpt → bge-m3 向量
 *   3. 向量检索 subject_nodes → top-K 候选
 *   4. 构造 LLM prompt（含学科树 + 向量候选 + content）
 *   5. LLM rerank → (subject_domain, confidence, reasoning)
 *   6. 阈值分流
 */
export async function classify(
  input: ClassifyInput,
  deps?: { db?: Database.Database },
): Promise<ClassificationResult> {
  const startMs = Date.now();
  const db = deps?.db ?? openWebDb(true);
  const shouldCloseDb = !deps?.db;

  try {
    // 1. Truncate content
    const { excerpt, truncated } = truncateContent(input);

    // 2. Load subject nodes
    const allNodes = loadAllSubjectNodes(db);

    // 3. Embed content and vector search
    let contentEmbedding: number[];
    try {
      contentEmbedding = await embedText(excerpt.slice(0, 1000));
    } catch (err) {
      return makeFailedResult(input.materialId, startMs, truncated, {
        error: `Embedding failed: ${(err as Error).message}`,
      });
    }

    const vectorCandidates = await vectorSearchSubjects(contentEmbedding, allNodes, db);

    // 4. Build LLM prompt
    const subjectTreeText = renderSubjectTreeText(allNodes);
    const userPrompt = buildUserPrompt(
      input.materialId,
      excerpt,
      subjectTreeText,
      input.language || 'zh',
      vectorCandidates,
    );

    // 5. LLM rerank
    let llmOutput: LlmOutput;
    try {
      const { data } = await chatJson<unknown>(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        { model: CLASSIFY_LLM_MODEL, temperature: 0.1, maxTokens: 256 },
      );
      const validated = validateLlmOutput(data);
      if (!validated) {
        return makeFailedResult(input.materialId, startMs, truncated, {
          error: `LLM output validation failed: ${JSON.stringify(data).slice(0, 200)}`,
        });
      }
      llmOutput = validated;
    } catch (err) {
      const msg =
        err instanceof LlmClientError
          ? `[${err.code}] ${err.message}`
          : (err as Error).message;
      return makeFailedResult(input.materialId, startMs, truncated, {
        error: msg,
      });
    }

    // 6. Resolve node ID and threshold routing
    const nodeId = resolveSubjectNodeId(llmOutput, allNodes, vectorCandidates);
    const confidence = llmOutput.confidence;
    const isAboveThreshold = confidence >= CONFIDENCE_THRESHOLD && nodeId !== null;

    const status: ClassificationResult['classificationStatus'] = isAboveThreshold
      ? 'auto_assigned'
      : 'pending';

    return {
      subjectDomain: llmOutput.subject_domain,
      subjectNodeId: isAboveThreshold ? nodeId : null,
      classificationStatus: status,
      confidence,
      isNewDomain: llmOutput.is_new_domain,
      suggestedPath: llmOutput.subject_path,
      reasoning: llmOutput.reasoning,
      meta: {
        model: CLASSIFY_LLM_MODEL,
        promptVersion: PROMPT_VERSION,
        latencyMs: Date.now() - startMs,
        truncated,
        cacheHit: false,
      },
    };
  } finally {
    if (shouldCloseDb) db.close();
  }
}

function makeFailedResult(
  materialId: string,
  startMs: number,
  truncated: boolean,
  opts: { error: string },
): ClassificationResult {
  return {
    subjectDomain: '',
    subjectNodeId: null,
    classificationStatus: 'extract_failed',
    confidence: 0,
    isNewDomain: false,
    suggestedPath: [],
    reasoning: '',
    meta: {
      model: CLASSIFY_LLM_MODEL,
      promptVersion: PROMPT_VERSION,
      latencyMs: Date.now() - startMs,
      truncated,
      cacheHit: false,
      error: opts.error,
    },
  };
}
