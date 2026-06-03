/**
 * Pipeline Worker — FR-A02 多模态文档编译管线（PDF 路径）
 *
 * 输入：task_queue type='process_pipeline' 的一条任务
 * 流程：
 *   1) 取出 material 行，校验 classification_status='classified' 且 asset_kind='pdf'
 *   2) 读 PDF bytes -> parsePdf 文本
 *   3) 切片（字符 budget，避免空依赖；与 src/extraction/chunk-strategy 思路一致）
 *   4) 每个切片调 penguin LLM 提取 entries（语义提取，禁止关键词匹配）
 *   5) entries 写入 entries 表，source_json 带 materialId/page，主体内容 metadata 关联学科
 *   6) 写一个 wiki_page 作为材料聚合页（FR-A02 AC9/10：导入状态 + 溯源）
 *   7) 更新 materials: pipeline_status='done', slice_count, extract_count, wiki_page_count
 *
 * 边界：本 worker 只处理 PDF；MP4/图片/手写 OCR 留给后续批次。其它 asset_kind
 * 不再伪造 done，只把 wiki_page_count 归零后保持 pending，等待对应管线接手。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import { openWebDb } from '@/lib/db';
import { ensureMaterialsTable } from '@/lib/wiki-materials-store';
import { getWikiRepository } from '@/lib/wiki-engine';
import { chatJson, LlmClientError } from '@/lib/llm/penguin-client';
import { embedBatch } from '@/lib/embedding-client';
import { queueSubjectGraphWriteForEntryIds } from '@kivo/graph/subject-graph-writer';

export const TASK_TYPE_PIPELINE = 'process_pipeline';
export const TASK_TYPE_EXTRACT_BATCH = 'extract_batch';
export const PIPELINE_MAX_RETRIES = 3;
export const CHUNK_TARGET_CHARS = Number(
  process.env.KIVO_PIPELINE_CHUNK_CHARS || 2400,
);
export const BATCH_SIZE = Number(
  process.env.KIVO_PIPELINE_BATCH_SIZE || 1,
);
export const PIPELINE_LLM_TIMEOUT_MS = Number(
  process.env.KIVO_PIPELINE_LLM_TIMEOUT_MS || 300_000,
);
export const PIPELINE_LLM_MODEL =
  process.env.KIVO_PIPELINE_LLM_MODEL ||
  process.env.KIVO_LLM_MODEL ||
  'gpt-5.5';

/**
 * Inline task_queue bootstrap to avoid circular import with dispatcher.ts.
 * dispatcher.ts imports this module; it cannot also be the source of
 * ensureTaskQueueTable for us.
 */
function ensureTaskQueueTableLocal(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_queue (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'waiting',
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_queue_status_type
      ON task_queue(status, type);
    CREATE INDEX IF NOT EXISTS idx_task_queue_created
      ON task_queue(created_at);
  `);
}

function ensureColumn(db: Database.Database, table: string, column: string, type: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function ensurePipelineExtractionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'fact',
      title TEXT NOT NULL DEFAULT '',
      content TEXT,
      summary TEXT,
      source_json TEXT,
      confidence REAL,
      status TEXT NOT NULL DEFAULT 'active',
      tags_json TEXT,
      domain TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ensureColumn(db, 'entries', 'subject_id', 'TEXT');
  ensureColumn(db, 'entries', 'entry_type', 'TEXT');
  ensureColumn(db, 'entries', 'embedding', 'BLOB');
}

interface PipelineTaskRow {
  id: string;
  type: string;
  payload: string;
  status: string;
  retry_count: number;
}

interface MaterialRow {
  id: string;
  file_name: string;
  mime_type: string;
  asset_kind: string | null;
  classification_status: string | null;
  pipeline_status: string | null;
  storage_path: string | null;
  space_id: string;
  subject_node_id: string | null;
  suggested_subject_name: string | null;
  content_override: string | null;
}

export interface PipelineResult {
  taskId: string;
  materialId: string;
  success: boolean;
  sliceCount: number;
  extractCount: number;
  wikiPageCount: number;
  wikiPageIds: string[];
  durationMs?: number;
  maxChunkDurationMs?: number;
  error?: string;
  skipped?: boolean;
  reason?: string;
}

interface LlmExtractedEntry {
  title?: string;
  content?: string;
  type?: string;
  tags?: string[];
  entry_type?: string;
  entry_fields?: Record<string, unknown>;
}

const VALID_TYPES = new Set([
  'fact',
  'methodology',
  'decision',
  'experience',
  'intent',
  'meta',
]);

const ENTRY_TYPE_VALUES = ['concept', 'method', 'question', 'mistake', 'annotation'] as const;
type EntryTypeValue = typeof ENTRY_TYPE_VALUES[number];
const VALID_ENTRY_TYPES: ReadonlySet<string> = new Set<string>(ENTRY_TYPE_VALUES);

const QUESTION_PATTERNS: RegExp[] = [
  /[设若已知][^\n。]{0,80}[，,][^\n。]{0,160}[求证证明计算解判断试讨论]/,
  /^\s*\d+[\.、)]\s*[设若已知试求证证明计算]/m,
  /^[（(]\s*\d+\s*[）)]\s*[设若已知试求证证明计算]/m,
  /证明[:：]/,
  /[计求][\s\S]{0,40}的(定义|关系|差异|原因|结果|影响|步骤|条件|范围|值)/,
  /[（(]\s*[1234567890I二三四五六七八九十]+\s*[）)]\s*$/m,
];

function looksLikeQuestion(text: string): boolean {
  if (!text) return false;
  return QUESTION_PATTERNS.some((re) => re.test(text));
}

const MISTAKE_KEYWORDS = ['易错', '常见错误', '误解', '错因', '陷阱', '注意区分', '不要把'];
const METHOD_KEYWORDS = ['解法', '方法', '步骤', '解题', '证明思路', '套路', '通法', '化简方法'];

function inferEntryType(args: {
  title: string;
  content: string;
  llmType: string;
  knowledgeType: string;
}): EntryTypeValue {
  const blob = `${args.title}\n${args.content}`;
  if (args.llmType && VALID_ENTRY_TYPES.has(args.llmType)) {
    if (looksLikeQuestion(blob) && args.llmType !== 'question') return 'question';
    return args.llmType as EntryTypeValue;
  }
  if (looksLikeQuestion(blob)) return 'question';
  if (MISTAKE_KEYWORDS.some((kw) => blob.includes(kw))) return 'mistake';
  if (args.knowledgeType === 'methodology') return 'method';
  if (METHOD_KEYWORDS.some((kw) => blob.includes(kw))) return 'method';
  return 'concept';
}

function normalizeEntryType(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const lower = raw.toLowerCase().trim();
  return VALID_ENTRY_TYPES.has(lower) ? lower : '';
}

function chunkPdfText(text: string, targetChars: number): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return [];
  const segments = text
    .split(/\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);

  const chunks: string[] = [];
  let buf = '';
  for (const seg of segments) {
    if (buf.length === 0) {
      buf = seg;
      continue;
    }
    if (buf.length + 1 + seg.length <= targetChars) {
      buf = `${buf}\n\n${seg}`;
    } else {
      chunks.push(buf);
      buf = seg;
    }
  }
  if (buf.length > 0) chunks.push(buf);

  if (chunks.length === 0 && cleaned.length > 0) {
    for (let i = 0; i < cleaned.length; i += targetChars) {
      chunks.push(cleaned.slice(i, i + targetChars));
    }
  }
  return chunks;
}

function buildExtractPrompt(args: {
  fileName: string;
  subjectName: string | null;
  chunkIndex: number;
  totalChunks: number;
  chunkText: string;
}): { system: string; user: string } {
  const subject = args.subjectName ? `（学科: ${args.subjectName}）` : '';
  const system = [
    '你是 KIVO 知识抽取专家。从给定的教材/讲义/题库切片里提取结构化知识条目。',
    '只输出 JSON 数组，元素形如 { "title", "content", "type", "tags", "entry_type", "entry_fields" }。',
    'type 必须是 fact|methodology|decision|experience|intent|meta 之一（知识类型）。',
    'entry_type 必须是 concept|method|question|mistake|annotation 之一（学科条目类型）：',
    '  - concept: 概念/定义/规则/边界/性质（如「核心概念的适用边界」）',
    '  - method: 操作方法/判断方法/通用步骤（如「拆解复杂问题的方法」）',
    '  - question: 问题原文（含「设…求…」「说明…」「判断…」等模式）—— 问题必须用 question，禁止归到 concept/method',
    '  - mistake: 易错点/常见错误/陷阱/错因分析',
    '  - annotation: 批注/笔记/补充说明',
    'entry_fields 按 entry_type 选填（若信息不足可省略字段）：',
    '  - concept/method/annotation: { difficulty(1-5), importance(high|medium|low), aliases[], properties{} }',
    '  - question: { difficulty, importance, source(真题|模拟|自编), answer, solution }',
    '  - mistake: { difficulty, importance, original_question, wrong_answer, error_cause, correction }',
    '准入标准（任一不满足即丢弃）：',
    '  1) 跨场景可复用，不是当前文档独有的临时叙述；',
    '  2) 抽象后仍是知识，而非"该书第 X 节讨论了 Y"这样的导览；',
    '  3) title 用 LLM 抽象后的短句（≤24 字），不要直接复制原句；',
    '  4) content 200~800 字，说明定义/定理/方法/结论 + 适用场景。',
    '严格输出纯 JSON 数组（不要 ``` 包裹），找不到合格条目时返回 []。',
  ].join('\n');

  const user = [
    `【文件】${args.fileName}${subject}`,
    `【切片】${args.chunkIndex + 1}/${args.totalChunks}`,
    '【原文】',
    args.chunkText,
    '',
    '从上面切片中提取知识条目，输出 JSON 数组。',
  ].join('\n');

  return { system, user };
}

function normalizeType(raw: unknown): string {
  if (typeof raw !== 'string') return 'fact';
  const lower = raw.toLowerCase().trim();
  return VALID_TYPES.has(lower) ? lower : 'fact';
}

function safeTitle(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const compact = raw.replace(/\s+/g, ' ').trim();
  return compact.length > 80 ? `${compact.slice(0, 79)}…` : compact;
}

function safeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .map((t) => t.trim().slice(0, 32))
    .slice(0, 8);
}

async function loadPdfBytes(storagePath: string): Promise<Uint8Array> {
  const abs = path.resolve(storagePath);
  const buf = await fs.promises.readFile(abs);
  return new Uint8Array(buf);
}

export async function parsePdfBytesToText(bytes: Uint8Array): Promise<string> {
  const mod: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Resolve pdf.worker.mjs absolutely via require.resolve so it works regardless
  // of process.cwd(). The previous cwd-based path broke when this code ran from
  // Next.js bundled chunks (e.g. .next/server/chunks/) because `node_modules` is
  // not located relative to the chunk file.
  let workerSrc: string | null = null;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    workerSrc = pathToFileURL(req.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
  } catch {
    const fallback = path.resolve(
      process.cwd(),
      'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    );
    workerSrc = pathToFileURL(fallback).href;
  }
  if (mod?.GlobalWorkerOptions && workerSrc) {
    mod.GlobalWorkerOptions.workerSrc = workerSrc;
  }
  const loadingTask = mod.getDocument({
    data: bytes,
    useSystemFonts: true,
    disableFontFace: true,
  });
  const doc = await loadingTask.promise;
  const parts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = content.items
      .map((it: any) => ('str' in it ? it.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

function fetchMaterialRow(db: Database.Database, id: string): MaterialRow | null {
  return (
    (db
      .prepare(
        `SELECT id, file_name, mime_type, asset_kind, classification_status,
                pipeline_status, storage_path, space_id, subject_node_id,
                suggested_subject_name, content_override
           FROM materials WHERE id = ?`,
      )
      .get(id) as MaterialRow | undefined) ?? null
  );
}

function markPipelineRunning(db: Database.Database, materialId: string): void {
  db.prepare(
    `UPDATE materials SET pipeline_status = 'in_progress', updated_at = datetime('now') WHERE id = ?`,
  ).run(materialId);
}

function buildInvalidDoneError(args: {
  sliceCount: number;
  extractCount: number;
  wikiPageCount: number;
}): string | null {
  if (args.sliceCount <= 0) return 'pipeline produced no slices; refusing to mark done';
  if (args.extractCount <= 0) return 'pipeline produced no extracted entries; refusing to mark done';
  if (args.wikiPageCount <= 0) return 'pipeline produced no wiki pages; refusing to mark done';
  return null;
}

function markPipelineDone(
  db: Database.Database,
  materialId: string,
  args: {
    sliceCount: number;
    extractCount: number;
    wikiPageIds: string[];
  },
): boolean {
  const wikiPageCount = args.wikiPageIds.length;
  const invalidDoneError = buildInvalidDoneError({
    sliceCount: args.sliceCount,
    extractCount: args.extractCount,
    wikiPageCount,
  });
  if (invalidDoneError) {
    markPipelineFailed(db, materialId, invalidDoneError);
    return false;
  }

  db.prepare(
    `UPDATE materials
        SET pipeline_status = 'done',
            slice_count = @slice,
            extract_count = @extract,
            wiki_page_count = @wikis,
            wiki_page_ids_json = @ids,
            status = 'done',
            error_message = NULL,
            updated_at = datetime('now')
      WHERE id = @id`,
  ).run({
    id: materialId,
    slice: args.sliceCount,
    extract: args.extractCount,
    wikis: wikiPageCount,
    ids: JSON.stringify(args.wikiPageIds),
  });
  return true;
}

function markPipelineFailed(
  db: Database.Database,
  materialId: string,
  error: string,
): void {
  db.prepare(
    `UPDATE materials
        SET pipeline_status = 'failed',
            status = 'failed',
            error_message = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(error.slice(0, 500), materialId);
}

function setTaskRunning(db: Database.Database, taskId: string): void {
  db.prepare(
    `UPDATE task_queue SET status='running', updated_at=datetime('now') WHERE id = ?`,
  ).run(taskId);
}

function setTaskDone(db: Database.Database, taskId: string): void {
  db.prepare(
    `UPDATE task_queue SET status='done', updated_at=datetime('now') WHERE id = ?`,
  ).run(taskId);
}

function setTaskWaitingOrFailed(
  db: Database.Database,
  taskId: string,
  retry: number,
  error: string,
): void {
  const next = retry >= PIPELINE_MAX_RETRIES ? 'failed' : 'waiting';
  db.prepare(
    `UPDATE task_queue
        SET status = @s, retry_count = @r, last_error = @e,
            updated_at = datetime('now')
      WHERE id = @id`,
  ).run({ id: taskId, s: next, r: retry, e: error.slice(0, 500) });
}

function insertEntry(
  db: Database.Database,
  args: {
    materialId: string;
    subjectId: string | null;
    pageNumber: number | null;
    sourceFile: string;
    raw: LlmExtractedEntry;
    embedding?: number[] | null;
  },
): { id: string; entryType: EntryTypeValue } | null {
  const content = (args.raw.content ?? '').toString().trim();
  if (content.length < 30) return null;
  const title = safeTitle(args.raw.title, content.slice(0, 24));
  const id = randomUUID();
  const now = new Date().toISOString();
  const sourceJson = JSON.stringify({
    type: 'document',
    reference: `material://${args.materialId}`,
    materialId: args.materialId,
    timestamp: now,
  });
  const tags = safeTags(args.raw.tags);
  const knowledgeType = normalizeType(args.raw.type);
  const entryType = inferEntryType({
    title,
    content,
    llmType: normalizeEntryType(args.raw.entry_type),
    knowledgeType,
  });
  const entryFields = (args.raw.entry_fields && typeof args.raw.entry_fields === 'object')
    ? (args.raw.entry_fields as Record<string, unknown>)
    : undefined;
  const metadata: Record<string, unknown> = {
    domainData: { materialIds: [args.materialId] },
    sourceRange: {
      documentId: args.sourceFile,
      page: args.pageNumber ?? undefined,
      originalText: content,
    },
    entry_type: entryType,
  };
  if (entryFields) metadata.entry_fields = entryFields;
  db.prepare(
    `INSERT INTO entries (
       id, type, title, content, summary, source_json, status, tags_json,
       version, metadata_json, subject_id, entry_type, embedding, created_at, updated_at, confidence
     ) VALUES (
       @id, @type, @title, @content, @summary, @source, 'active', @tags,
       1, @meta, @subject, @entryType, @embedding, @now, @now, 0.7
     )`,
  ).run({
    id,
    type: knowledgeType,
    title,
    content,
    summary: content.slice(0, 200),
    source: sourceJson,
    tags: JSON.stringify(tags),
    meta: JSON.stringify(metadata),
    subject: args.subjectId,
    entryType,
    embedding: args.embedding ? Buffer.from(new Float32Array(args.embedding).buffer) : null,
    now,
  });
  return { id, entryType };
}

function buildMaterialWikiContent(args: {
  fileName: string;
  subjectName: string | null;
  sliceCount: number;
  entries: Array<{ title: string; content: string; type: string }>;
}): { content: string; summary: string } {
  const head = [
    `# ${args.fileName}`,
    '',
    args.subjectName ? `**学科**: ${args.subjectName}` : '',
    `**切片数**: ${args.sliceCount}　**提取知识条目**: ${args.entries.length}`,
    '',
  ]
    .filter(Boolean)
    .join('\n');

  const body = args.entries
    .map((e, idx) => {
      const c = e.content.length > 400 ? `${e.content.slice(0, 400)}…` : e.content;
      return `### ${idx + 1}. ${e.title}\n\n_${e.type}_\n\n${c}\n`;
    })
    .join('\n');

  const content = `${head}\n${body}`.trim();
  const summary =
    args.entries.length > 0
      ? `${args.fileName} 提取 ${args.entries.length} 条知识，含 ${args.entries
          .slice(0, 3)
          .map((e) => e.title)
          .join('、')}…`
      : `${args.fileName} 暂未提取出合格知识条目（切片 ${args.sliceCount}）`;

  return { content, summary: summary.slice(0, 240) };
}

export async function executePipelineTask(
  task: PipelineTaskRow,
): Promise<PipelineResult> {
  const db = openWebDb(false);
  ensureMaterialsTable(db);
  ensurePipelineExtractionSchema(db);
  ensureTaskQueueTableLocal(db);

  let materialId = '';
  try {
    let payload: { materialId: string };
    try {
      payload = JSON.parse(task.payload);
      materialId = payload.materialId;
    } catch {
      const error = `Invalid pipeline payload: ${task.payload?.slice(0, 100)}`;
      setTaskWaitingOrFailed(db, task.id, task.retry_count + 1, error);
      return {
        taskId: task.id,
        materialId: '',
        success: false,
        sliceCount: 0,
        extractCount: 0,
        wikiPageCount: 0,
        wikiPageIds: [],
        error,
      };
    }

    setTaskRunning(db, task.id);
    const material = fetchMaterialRow(db, materialId);
    if (!material) {
      const error = `Material ${materialId} not found`;
      setTaskWaitingOrFailed(db, task.id, task.retry_count + 1, error);
      return {
        taskId: task.id,
        materialId,
        success: false,
        sliceCount: 0,
        extractCount: 0,
        wikiPageCount: 0,
        wikiPageIds: [],
        error,
      };
    }

    if (material.classification_status !== 'classified') {
      const reason = `material classification_status=${material.classification_status}; pipeline only runs after classification`;
      setTaskDone(db, task.id);
      return {
        taskId: task.id,
        materialId,
        success: true,
        sliceCount: 0,
        extractCount: 0,
        wikiPageCount: 0,
        wikiPageIds: [],
        skipped: true,
        reason,
      };
    }

    const contentOverride = material.content_override?.trim() ?? '';

    const isPdfMaterial =
      (material.asset_kind || '').toLowerCase() === 'pdf' ||
      (material.mime_type || '').toLowerCase() === 'application/pdf';
    if (!contentOverride && !isPdfMaterial) {
      const reason = `asset_kind=${material.asset_kind} mime_type=${material.mime_type} not supported in this pipeline batch (PDF only)`;
      db.prepare(
        `UPDATE materials
            SET pipeline_status = 'pending',
                wiki_page_count = 0,
                wiki_page_ids_json = '[]',
                updated_at = datetime('now')
          WHERE id = ?`,
      ).run(materialId);
      setTaskDone(db, task.id);
      return {
        taskId: task.id,
        materialId,
        success: true,
        sliceCount: 0,
        extractCount: 0,
        wikiPageCount: 0,
        wikiPageIds: [],
        skipped: true,
        reason,
      };
    }

    if (!contentOverride && !material.storage_path) {
      const error = 'storage_path is empty; cannot read PDF bytes';
      markPipelineFailed(db, materialId, error);
      setTaskWaitingOrFailed(db, task.id, task.retry_count + 1, error);
      return {
        taskId: task.id,
        materialId,
        success: false,
        sliceCount: 0,
        extractCount: 0,
        wikiPageCount: 0,
        wikiPageIds: [],
        error,
      };
    }

    markPipelineRunning(db, materialId);

    let pdfText = contentOverride;
    if (!pdfText) {
      const storagePath = material.storage_path;
      if (!storagePath) {
        const error = 'storage_path is empty; cannot read PDF bytes';
        markPipelineFailed(db, materialId, error);
        setTaskWaitingOrFailed(db, task.id, task.retry_count + 1, error);
        return {
          taskId: task.id,
          materialId,
          success: false,
          sliceCount: 0,
          extractCount: 0,
          wikiPageCount: 0,
          wikiPageIds: [],
          error,
        };
      }

      const bytes = await loadPdfBytes(storagePath);
      try {
        pdfText = await parsePdfBytesToText(bytes);
      } catch (err) {
        const error = `parsePdf failed: ${(err as Error).message}`;
        markPipelineFailed(db, materialId, error);
        setTaskWaitingOrFailed(db, task.id, task.retry_count + 1, error);
        return {
          taskId: task.id,
          materialId,
          success: false,
          sliceCount: 0,
          extractCount: 0,
          wikiPageCount: 0,
          wikiPageIds: [],
          error,
        };
      }
    }

    const allChunks = chunkPdfText(pdfText, CHUNK_TARGET_CHARS);
    const totalChunks = allChunks.length;

    if (totalChunks === 0) {
      const error = 'PDF produced no text chunks';
      markPipelineFailed(db, materialId, error);
      setTaskWaitingOrFailed(db, task.id, task.retry_count + 1, error);
      return {
        taskId: task.id,
        materialId,
        success: false,
        sliceCount: 0,
        extractCount: 0,
        wikiPageCount: 0,
        wikiPageIds: [],
        error,
      };
    }

    // Store total_chunks and set processing status
    db.prepare(
      `UPDATE materials
          SET total_chunks = @total,
              processed_chunks = 0,
              batch_cursor = 0,
              pipeline_status = 'processing',
              updated_at = datetime('now')
        WHERE id = @id`,
    ).run({ id: materialId, total: totalChunks });

    // Enqueue extract_batch tasks, each covering BATCH_SIZE chunks
    const batchCount = Math.ceil(totalChunks / BATCH_SIZE);
    for (let batchIdx = 0; batchIdx < batchCount; batchIdx++) {
      const startIdx = batchIdx * BATCH_SIZE;
      const endIdx = Math.min(startIdx + BATCH_SIZE, totalChunks);
      const batchPayload = JSON.stringify({
        materialId,
        batchIndex: batchIdx,
        startChunkIdx: startIdx,
        endChunkIdx: endIdx,
        totalChunks,
        chunks: allChunks.slice(startIdx, endIdx),
      });
      db.prepare(
        `INSERT INTO task_queue (id, type, payload, status, retry_count, created_at, updated_at)
         VALUES (?, ?, ?, 'waiting', 0, datetime('now'), datetime('now'))`,
      ).run(randomUUID(), TASK_TYPE_EXTRACT_BATCH, batchPayload);
    }

    setTaskDone(db, task.id);

    return {
      taskId: task.id,
      materialId,
      success: true,
      sliceCount: totalChunks,
      extractCount: 0,
      wikiPageCount: 0,
      wikiPageIds: [],
    };
  } catch (err) {
    const error = `pipeline-worker uncaught: ${(err as Error).message}`;
    if (materialId) {
      try {
        markPipelineFailed(db, materialId, error);
      } catch {
        /* ignore */
      }
    }
    try {
      setTaskWaitingOrFailed(db, task.id, task.retry_count + 1, error);
    } catch {
      /* ignore */
    }
    return {
      taskId: task.id,
      materialId,
      success: false,
      sliceCount: 0,
      extractCount: 0,
      wikiPageCount: 0,
      wikiPageIds: [],
      error,
    };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Execute a single extract_batch task.
 * Processes one batch of chunks for a material, updates progress,
 * and finalizes the material when all batches are complete.
 */
export async function executeExtractBatchTask(
  task: PipelineTaskRow,
): Promise<PipelineResult> {
  const taskStartMs = Date.now();
  const db = openWebDb(false);
  ensureMaterialsTable(db);
  ensurePipelineExtractionSchema(db);
  ensureTaskQueueTableLocal(db);

  let materialId = '';
  try {
    let payload: {
      materialId: string;
      batchIndex: number;
      startChunkIdx: number;
      endChunkIdx: number;
      totalChunks: number;
      chunks: string[];
    };
    try {
      payload = JSON.parse(task.payload);
      materialId = payload.materialId;
    } catch {
      const error = `Invalid extract_batch payload: ${task.payload?.slice(0, 100)}`;
      setTaskWaitingOrFailed(db, task.id, task.retry_count + 1, error);
      return {
        taskId: task.id,
        materialId: '',
        success: false,
        sliceCount: 0,
        extractCount: 0,
        wikiPageCount: 0,
        wikiPageIds: [],
        error,
      };
    }

    setTaskRunning(db, task.id);
    const material = fetchMaterialRow(db, materialId);
    if (!material) {
      const error = `Material ${materialId} not found`;
      setTaskWaitingOrFailed(db, task.id, task.retry_count + 1, error);
      return {
        taskId: task.id,
        materialId,
        success: false,
        sliceCount: 0,
        extractCount: 0,
        wikiPageCount: 0,
        wikiPageIds: [],
        error,
      };
    }

    const { chunks, startChunkIdx, totalChunks } = payload;
    const batchSize = chunks.length;

    // Process each chunk in this batch
    const collected: Array<{
      title: string;
      content: string;
      type: string;
      tags: string[];
      entry_type?: string;
      entry_fields?: Record<string, unknown>;
    }> = [];
    let maxChunkDurationMs = 0;
    let failedChunks = 0;

    for (let i = 0; i < chunks.length; i++) {
      const globalIdx = startChunkIdx + i;
      const chunkStartMs = Date.now();
      const { system, user } = buildExtractPrompt({
        fileName: material.file_name,
        subjectName: material.suggested_subject_name,
        chunkIndex: globalIdx,
        totalChunks,
        chunkText: chunks[i],
      });
      let raw: unknown;
      try {
        const { data } = await chatJson<unknown>(
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          {
            model: PIPELINE_LLM_MODEL,
            temperature: 0.1,
            maxTokens: 1500,
            timeoutMs: PIPELINE_LLM_TIMEOUT_MS,
          },
        );
        raw = data;
        const chunkDurationMs = Date.now() - chunkStartMs;
        maxChunkDurationMs = Math.max(maxChunkDurationMs, chunkDurationMs);
        console.log(
          `[pipeline-worker] extract chunk ${globalIdx + 1}/${totalChunks} completed in ${chunkDurationMs}ms for ${material.file_name}`,
        );
      } catch (err) {
        const chunkDurationMs = Date.now() - chunkStartMs;
        maxChunkDurationMs = Math.max(maxChunkDurationMs, chunkDurationMs);
        const message =
          err instanceof LlmClientError
            ? `[${err.code}] ${err.message}`
            : (err as Error).message;
        console.warn(
          `[pipeline-worker] LLM batch chunk ${globalIdx + 1}/${totalChunks} failed after ${chunkDurationMs}ms for ${material.file_name}: ${message}`,
        );
        failedChunks++;
        continue;
      }

      let arr: LlmExtractedEntry[] = [];
      if (Array.isArray(raw)) {
        arr = raw as LlmExtractedEntry[];
      } else if (raw && typeof raw === 'object' && Array.isArray((raw as any).entries)) {
        arr = (raw as any).entries as LlmExtractedEntry[];
      }

      for (const item of arr) {
        const content = (item.content ?? '').toString().trim();
        if (content.length < 30) continue;
        const fields = (item.entry_fields && typeof item.entry_fields === 'object')
          ? (item.entry_fields as Record<string, unknown>)
          : undefined;
        collected.push({
          title: safeTitle(item.title, content.slice(0, 24)),
          content,
          type: normalizeType(item.type),
          tags: safeTags(item.tags),
          entry_type: normalizeEntryType(item.entry_type) || undefined,
          entry_fields: fields,
        });
      }
    }

    // Atomic batch: if any chunk in this batch failed its LLM extraction, do
    // NOT advance processed_chunks. Counting failed chunks as "processed" would
    // let the material reach 'done' with missing knowledge (false success).
    // Retry the whole batch instead so progress only advances on full success.
    // Returning before insertion also avoids duplicating entries from the
    // chunks that did succeed when the batch is re-run.
    if (failedChunks > 0) {
      const error = `extract_batch ${payload.batchIndex}: ${failedChunks}/${batchSize} chunk(s) failed LLM extraction; retrying batch without advancing progress`;
      setTaskWaitingOrFailed(db, task.id, task.retry_count + 1, error);
      return {
        taskId: task.id,
        materialId,
        success: false,
        sliceCount: 0,
        extractCount: 0,
        wikiPageCount: 0,
        wikiPageIds: [],
        error,
        durationMs: Date.now() - taskStartMs,
        maxChunkDurationMs,
      };
    }

    const embeddingsByIndex = new Map<number, number[]>();
    if (collected.length > 0) {
      try {
        const texts = collected.map((item) => `${item.title}\n${item.content}`);
        const { embeddings } = await embedBatch(texts);
        embeddings.forEach((embedding, index) => {
          if (Array.isArray(embedding) && embedding.length > 0) {
            embeddingsByIndex.set(index, embedding);
          }
        });
      } catch (err) {
        console.warn(
          `[pipeline-worker] embedding batch failed for ${material.file_name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Insert extracted entries
    let extractCount = 0;
    const insertedEntryIds: string[] = [];
    const insertTxn = db.transaction(() => {
      for (let index = 0; index < collected.length; index++) {
        const item = collected[index];
        const inserted = insertEntry(db, {
          materialId,
          subjectId: material.subject_node_id,
          pageNumber: null,
          sourceFile: material.file_name,
          raw: item,
          embedding: embeddingsByIndex.get(index) ?? null,
        });
        if (inserted) {
          extractCount++;
          insertedEntryIds.push(inserted.id);
        }
      }
    });
    insertTxn();
    if (insertedEntryIds.length > 0) {
      await queueSubjectGraphWriteForEntryIds(db, insertedEntryIds);
    }

    // Update processed_chunks progress
    db.prepare(
      `UPDATE materials
          SET processed_chunks = processed_chunks + @batch,
              extract_count = extract_count + @extracted,
              updated_at = datetime('now')
        WHERE id = @id`,
    ).run({ id: materialId, batch: batchSize, extracted: extractCount });

    // Check if all batches are complete
    const updated = db.prepare(
      `SELECT total_chunks, processed_chunks, file_name, mime_type, space_id,
              suggested_subject_name, subject_node_id
         FROM materials WHERE id = ?`,
    ).get(materialId) as {
      total_chunks: number;
      processed_chunks: number;
      file_name: string;
      mime_type: string;
      space_id: string;
      suggested_subject_name: string | null;
      subject_node_id: string | null;
    } | undefined;

    if (updated && updated.processed_chunks >= updated.total_chunks) {
      // All batches done — create wiki page and finalize
      const totalExtractCount = (db.prepare(
        `SELECT COUNT(*) as cnt FROM entries
          WHERE json_extract(source_json, '$.materialId') = ?
            AND COALESCE(status, 'active') != 'deleted'`,
      ).get(materialId) as { cnt: number }).cnt;

      const allEntries = db.prepare(
        `SELECT title, content, type FROM entries
          WHERE json_extract(source_json, '$.materialId') = ?
            AND COALESCE(status, 'active') != 'deleted'
          ORDER BY created_at ASC`,
      ).all(materialId) as Array<{ title: string; content: string; type: string }>;

      const wiki = buildMaterialWikiContent({
        fileName: updated.file_name,
        subjectName: updated.suggested_subject_name,
        sliceCount: updated.total_chunks,
        entries: allEntries,
      });

      const repo = getWikiRepository();
      let spaceId = material.space_id;
      if (!spaceId || spaceId === 'default') {
        const spaces = repo.listSpaces();
        const seed = spaces.find((s) => s.type === 'wiki_space');
        if (seed) spaceId = seed.id;
      } else {
        const node = repo.findById(spaceId);
        if (!node || node.type !== 'wiki_space') {
          const seed = repo.listSpaces().find((s) => s.type === 'wiki_space');
          if (seed) spaceId = seed.id;
        }
      }

      let wikiPageIds: string[] = [];
      try {
        const tags = [
          ...(updated.suggested_subject_name ? [updated.suggested_subject_name] : []),
          'auto-pipeline',
        ];
        const page = repo.createPage({
          title: updated.file_name,
          content: wiki.content,
          summary: wiki.summary,
          tags,
          parentId: spaceId,
          metadata: {
            source: {
              type: 'document',
              uri: `material://${materialId}`,
              fileName: updated.file_name,
              mimeType: updated.mime_type,
              collectedAt: new Date().toISOString(),
            },
            tags,
            summary: wiki.summary,
            embeddingStatus: 'pending',
            syncStatus: 'ok',
            warnings: [],
            extra: {
              pipeline: 'pdf-llm-v2-batch',
              materialId,
              totalChunks: updated.total_chunks,
              totalExtractCount,
              batchSize: BATCH_SIZE,
              chunkTargetChars: CHUNK_TARGET_CHARS,
            },
          },
        });
        wikiPageIds = [page.id];
      } catch (err) {
        const error = `wiki createPage failed: ${(err as Error).message}`;
        markPipelineFailed(db, materialId, error);
        setTaskDone(db, task.id);
        return {
          taskId: task.id,
          materialId,
          success: false,
          sliceCount: updated.total_chunks,
          extractCount: totalExtractCount,
          wikiPageCount: 0,
          wikiPageIds: [],
          error,
        };
      }

      // Mark material as done
      db.prepare(
        `UPDATE materials
            SET pipeline_status = 'done',
                slice_count = @slice,
                extract_count = @extract,
                wiki_page_count = @wikis,
                wiki_page_ids_json = @ids,
                content_override = NULL,
                status = 'done',
                error_message = NULL,
                updated_at = datetime('now')
          WHERE id = @id`,
      ).run({
        id: materialId,
        slice: updated.total_chunks,
        extract: totalExtractCount,
        wikis: wikiPageIds.length,
        ids: JSON.stringify(wikiPageIds),
      });

      setTaskDone(db, task.id);
      return {
        taskId: task.id,
        materialId,
        success: true,
        sliceCount: updated.total_chunks,
        extractCount: totalExtractCount,
        wikiPageCount: wikiPageIds.length,
        wikiPageIds,
        durationMs: Date.now() - taskStartMs,
        maxChunkDurationMs,
      };
    }

    // Not all batches done yet — just mark this batch task as done
    setTaskDone(db, task.id);
    return {
      taskId: task.id,
      materialId,
      success: true,
      sliceCount: batchSize,
      extractCount,
      wikiPageCount: 0,
      wikiPageIds: [],
      durationMs: Date.now() - taskStartMs,
      maxChunkDurationMs,
    };
  } catch (err) {
    const error = `extract_batch uncaught: ${(err as Error).message}`;
    if (materialId) {
      try {
        // Don't mark the whole material as failed for a single batch failure;
        // the retry mechanism will handle it
      } catch {
        /* ignore */
      }
    }
    try {
      setTaskWaitingOrFailed(db, task.id, task.retry_count + 1, error);
    } catch {
      /* ignore */
    }
    return {
      taskId: task.id,
      materialId,
      success: false,
      sliceCount: 0,
      extractCount: 0,
      wikiPageCount: 0,
      wikiPageIds: [],
      error,
    };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 把 classified 但 pipeline 还没完成的 material 入队（process_pipeline）。
 * 与 dispatcher 的 backfillPendingMaterials 同精神：保证 SQL 真相 → task 真相
 * 一致，避免依赖具体路由调用方手工 enqueue。
 */
export function enqueuePipelineTaskForMaterial(
  db: Database.Database,
  materialId: string,
): string | null {
  ensureTaskQueueTableLocal(db);
  const existing = db
    .prepare(
      `SELECT id FROM task_queue
        WHERE type = ?
          AND json_extract(payload, '$.materialId') = ?
          AND status IN ('waiting','running')
        LIMIT 1`,
    )
    .get(TASK_TYPE_PIPELINE, materialId) as { id: string } | undefined;
  if (existing) return null;

  const id = randomUUID();
  db.prepare(
    `INSERT INTO task_queue (id, type, payload, status, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, 'waiting', 0, datetime('now'), datetime('now'))`,
  ).run(id, TASK_TYPE_PIPELINE, JSON.stringify({ materialId }));
  return id;
}

export function backfillPipelineForClassified(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT m.id
         FROM materials m
        WHERE m.classification_status = 'classified'
          AND (m.pipeline_status IS NULL OR m.pipeline_status IN ('pending','classified','failed'))
          AND NOT EXISTS (
            SELECT 1 FROM task_queue t
             WHERE t.type = 'process_pipeline'
               AND json_extract(t.payload, '$.materialId') = m.id
               AND t.status IN ('waiting','running')
          )
        ORDER BY m.created_at ASC
        LIMIT 50`,
    )
    .all() as Array<{ id: string }>;
  let n = 0;
  for (const r of rows) {
    if (enqueuePipelineTaskForMaterial(db, r.id)) n++;
  }
  return n;
}
