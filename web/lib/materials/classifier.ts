/**
 * lib/materials/classifier.ts — Wave 1 / A2 后台分类调度
 *
 * 任务边界（spec FR-A02）：
 *  - 输入：materials.classification_status='pending' 的一行
 *  - 处理：调 LLM 把 material 的 title/source_ref/asset_kind 与当前
 *    L0/L1 学科域名清单一起送 prompt，让 LLM 选一个 subject 节点 +
 *    给出 confidence 0~1 + 理由
 *  - 输出：写回 materials 行
 *      - confidence ≥ 0.7 → status='classified', subject_node_id 落库
 *      - confidence < 0.7  → status='pending_classification', 仅写
 *        suggested_subject_name + confidence + reason，subject_node_id
 *        留空，等用户在 C1 队列里复核
 *
 * 不动 schema：classification_reason 列通过 ensureColumn 在运行时按需
 * 添加（与 A1 ensureMaterialsTable 同一模式），避免改 migrations。
 */

import type Database from 'better-sqlite3';
import { openWebDb } from '@/lib/db';
import { ensureMaterialsTable } from '@/lib/wiki-materials-store';
import { getSubjectRepository } from '@/lib/subjects/repository';
import { chatJson, LlmClientError } from '@/lib/llm/penguin-client';
import type { SubjectTreeNode } from '@/lib/types/subject';
import { enqueuePipelineTaskForMaterial } from '@/lib/queue/pipeline-worker';

/** 阈值统一 0.7（FR-A02 / 任务约束）。允许 env override 用于调试。 */
export const CLASSIFICATION_THRESHOLD = Number(
  process.env.KIVO_CLASSIFY_THRESHOLD || 0.7,
);

export const STATUS_CLASSIFIED = 'classified';
export const STATUS_PENDING_LOWCONF = 'pending_classification';
export const STATUS_FAILED = 'failed';
export const STATUS_PENDING = 'pending';

/** 单条分类对外结果 */
export interface ClassifyResult {
  materialId: string;
  status:
    | typeof STATUS_CLASSIFIED
    | typeof STATUS_PENDING_LOWCONF
    | typeof STATUS_FAILED;
  subjectNodeId: string | null;
  suggestedSubjectName: string | null;
  confidence: number | null;
  reason: string | null;
  error?: string;
}

/** 批量结果 */
export interface ClassifyBatchResult {
  processed: number;
  classified: number;
  pending: number;
  failed: number;
  results: ClassifyResult[];
}

interface MaterialRow {
  id: string;
  title: string;
  asset_kind: string | null;
  source_ref: string | null;
  source_channel: string | null;
  classification_status: string | null;
}

interface SubjectCandidate {
  id: string;
  name: string;
  level: number;
  parentName: string | null;
}

/** LLM 期望返回的 JSON 形状 */
interface LlmClassification {
  subjectNodeId?: string | null;
  confidence?: number;
  reason?: string;
}

/**
 * 确保 materials 表上有 classification_reason 列。沿用 A1 的轻量
 * "存在则跳过" 模式，幂等且向后兼容。
 */
function ensureClassificationReasonColumn(db: Database.Database): void {
  const rows = db
    .prepare('PRAGMA table_info(materials)')
    .all() as Array<{ name: string }>;
  if (!rows.some((r) => r.name === 'classification_reason')) {
    db.exec('ALTER TABLE materials ADD COLUMN classification_reason TEXT');
  }
}

/**
 * 准备一次分类调用所需的环境（DB + schema 兜底）。调用方负责关闭 db。
 */
function openDbForClassification(): Database.Database {
  const db = openWebDb(false);
  ensureMaterialsTable(db);
  ensureClassificationReasonColumn(db);
  return db;
}

/**
 * 取出 L0 + L1 节点作为候选；L2 太细，对入库分类来说粒度过低（B4 split 才会用 L2 级别）
 */
export function loadSubjectCandidates(): SubjectCandidate[] {
  const repo = getSubjectRepository();
  const tree = repo.listTree();
  const out: SubjectCandidate[] = [];
  const walk = (node: SubjectTreeNode, parentName: string | null) => {
    if (node.level === 0 || node.level === 1) {
      out.push({
        id: node.id,
        name: node.name,
        level: node.level,
        parentName,
      });
    }
    for (const child of node.children) {
      walk(child, node.name);
    }
  };
  for (const root of tree) walk(root, null);
  return out;
}

function fetchMaterialRow(
  db: Database.Database,
  id: string,
): MaterialRow | null {
  const row = db
    .prepare(
      `SELECT id, file_name AS title, asset_kind, source_ref, source_channel,
              classification_status
         FROM materials WHERE id = ?`,
    )
    .get(id) as MaterialRow | undefined;
  return row ?? null;
}

function fetchPendingMaterials(
  db: Database.Database,
  limit: number,
): MaterialRow[] {
  return db
    .prepare(
      `SELECT id, file_name AS title, asset_kind, source_ref, source_channel,
              classification_status
         FROM materials
        WHERE classification_status = 'pending'
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(limit) as MaterialRow[];
}

/**
 * 构造 LLM prompt。把候选学科域以紧凑格式列出，附 id / 名称 / 层级 /
 * 父域名，便于 LLM 选最贴合的节点。
 */
export function buildPrompt(
  material: MaterialRow,
  candidates: SubjectCandidate[],
): { system: string; user: string } {
  const subjectsBlock = candidates
    .map((c) => {
      const parent = c.parentName ? ` (父域: ${c.parentName})` : '';
      return `- id="${c.id}" | level=L${c.level} | name="${c.name}"${parent}`;
    })
    .join('\n');

  const system = [
    'You are a knowledge classifier for KIVO, an external materials ingestion system.',
    'Pick the SINGLE best subject node for the given material from the candidate list.',
    'Output STRICT JSON ONLY, with keys: subjectNodeId (string), confidence (number 0~1), reason (string in Chinese, ≤120 chars).',
    'Confidence rules:',
    '  - 0.9~1.0: title or source_ref clearly belongs to that subject',
    '  - 0.7~0.9: strong topical match',
    '  - 0.4~0.7: weak / partial match (use this when uncertain)',
    '  - 0.0~0.4: no good candidate (still pick the closest, low confidence)',
    'NEVER invent subjectNodeId values; only use ids from the candidate list.',
  ].join('\n');

  const user = [
    '【素材】',
    `- title: ${material.title}`,
    `- assetKind: ${material.asset_kind ?? 'unknown'}`,
    `- sourceChannel: ${material.source_channel ?? 'unknown'}`,
    `- sourceRef: ${material.source_ref ?? '(none)'}`,
    '',
    '【候选学科域】（必须从中选一个 id）',
    subjectsBlock || '(empty)',
    '',
    '请输出 JSON：{ "subjectNodeId": "<id>", "confidence": <0~1>, "reason": "<中文理由>" }',
  ].join('\n');

  return { system, user };
}

/**
 * 把 LLM 返回的原始结果与候选清单做二次校验：subjectNodeId 必须在
 * 候选集中；不在则强制 confidence=0 并打回 pending_classification。
 */
function normalizeLlmResult(
  raw: LlmClassification,
  candidates: SubjectCandidate[],
): { subjectNodeId: string | null; confidence: number; reason: string; subjectName: string | null } {
  const id = typeof raw.subjectNodeId === 'string' ? raw.subjectNodeId.trim() : null;
  let confidence = typeof raw.confidence === 'number' ? raw.confidence : 0;
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const reason =
    typeof raw.reason === 'string' && raw.reason.trim()
      ? raw.reason.trim().slice(0, 500)
      : 'LLM 未提供理由';

  if (!id) {
    return { subjectNodeId: null, confidence: 0, reason, subjectName: null };
  }
  const hit = candidates.find((c) => c.id === id);
  if (!hit) {
    return {
      subjectNodeId: null,
      confidence: Math.min(confidence, 0.4),
      reason: `LLM 选了候选外的 id=${id}; 已降级为低置信度。原因：${reason}`,
      subjectName: null,
    };
  }
  return { subjectNodeId: hit.id, confidence, reason, subjectName: hit.name };
}

/**
 * 写回 DB：根据 confidence 阈值分流。
 */
function persistClassification(
  db: Database.Database,
  materialId: string,
  subjectNodeId: string | null,
  subjectName: string | null,
  confidence: number,
  reason: string,
): ClassifyResult['status'] {
  const now = new Date().toISOString();
  const status: ClassifyResult['status'] =
    confidence >= CLASSIFICATION_THRESHOLD && subjectNodeId
      ? STATUS_CLASSIFIED
      : STATUS_PENDING_LOWCONF;

  // 高置信度才把 subject_node_id 落到主键，低置信度只留 suggested
  // 名字让用户在 pending 列表里挑（避免错关联干扰下游召回）。
  const updateStmt = db.prepare(`
    UPDATE materials
       SET classification_status = @status,
           classification_confidence = @confidence,
           suggested_subject_name = @suggestedName,
           classification_reason = @reason,
           subject_node_id = @subjectNodeId,
           updated_at = @updatedAt
     WHERE id = @id
  `);

  updateStmt.run({
    id: materialId,
    status,
    confidence,
    suggestedName: subjectName,
    reason,
    subjectNodeId: status === STATUS_CLASSIFIED ? subjectNodeId : null,
    updatedAt: now,
  });

  if (status === STATUS_CLASSIFIED) {
    // FR-A02: classify 落库后立即入队 process_pipeline
    try {
      enqueuePipelineTaskForMaterial(db, materialId);
    } catch {
      /* 下次 backfill 兜底 */
    }
  }

  return status;
}

/**
 * 单条分类入口：纯业务函数，路由层薄包装即可。
 */
export async function classifySingle(
  materialId: string,
): Promise<ClassifyResult> {
  const db = openDbForClassification();
  try {
    const material = fetchMaterialRow(db, materialId);
    if (!material) {
      return {
        materialId,
        status: STATUS_FAILED,
        subjectNodeId: null,
        suggestedSubjectName: null,
        confidence: null,
        reason: null,
        error: `material ${materialId} not found`,
      };
    }

    const candidates = loadSubjectCandidates();
    if (candidates.length === 0) {
      return {
        materialId,
        status: STATUS_FAILED,
        subjectNodeId: null,
        suggestedSubjectName: null,
        confidence: null,
        reason: null,
        error: 'no L0/L1 subject candidates available',
      };
    }

    const { system, user } = buildPrompt(material, candidates);
    let llmRaw: LlmClassification;
    try {
      const { data } = await chatJson<LlmClassification>(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { temperature: 0, maxTokens: 400 },
      );
      llmRaw = data;
    } catch (err) {
      const message =
        err instanceof LlmClientError
          ? `[${err.code}] ${err.message}`
          : (err as Error).message;
      return {
        materialId,
        status: STATUS_FAILED,
        subjectNodeId: null,
        suggestedSubjectName: null,
        confidence: null,
        reason: null,
        error: message,
      };
    }

    const norm = normalizeLlmResult(llmRaw, candidates);
    const finalStatus = persistClassification(
      db,
      materialId,
      norm.subjectNodeId,
      norm.subjectName,
      norm.confidence,
      norm.reason,
    );

    return {
      materialId,
      status: finalStatus,
      subjectNodeId: finalStatus === STATUS_CLASSIFIED ? norm.subjectNodeId : null,
      suggestedSubjectName: norm.subjectName,
      confidence: norm.confidence,
      reason: norm.reason,
    };
  } finally {
    db.close();
  }
}

/**
 * 批量入口：扫 pending（最多 max 条），串行调用 classifySingle。
 * 串行而非并行的理由：penguin LLM key 单并发限流敏感，串行 + 短间隔
 * 比并行更稳；批次上限 20 防止单次请求阻塞太久。
 */
export async function classifyBatch(maxArg = 20): Promise<ClassifyBatchResult> {
  const max = Math.max(1, Math.min(20, Math.floor(maxArg)));
  const db = openDbForClassification();
  let pendingRows: MaterialRow[];
  try {
    pendingRows = fetchPendingMaterials(db, max);
  } finally {
    db.close();
  }

  const results: ClassifyResult[] = [];
  let classified = 0;
  let pending = 0;
  let failed = 0;
  for (const row of pendingRows) {
    // 复用 classifySingle 单条路径，保证主路径只有一份逻辑。
    // eslint-disable-next-line no-await-in-loop
    const r = await classifySingle(row.id);
    results.push(r);
    if (r.status === STATUS_CLASSIFIED) classified++;
    else if (r.status === STATUS_PENDING_LOWCONF) pending++;
    else failed++;
  }
  return {
    processed: results.length,
    classified,
    pending,
    failed,
    results,
  };
}
