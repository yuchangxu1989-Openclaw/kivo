#!/usr/bin/env node
/**
 * KIVO Batch1 — Inbound 真材料导入 + 数据源对齐
 *
 * 任务来源: 用户口令 [Sun 2026-05-24 17:15 GMT+8] sevo:create kivo
 * 报告: reports/kivo-fix-batch1-cc-real-materials-2026-05-24.md
 *
 * 流程:
 *  1) 清 70 孤儿 wiki_page + 10 wiki_directory + 1 wiki_space (probstat 残留)
 *  2) 删 3 条 5/23 占位 materials
 *  3) 导入 inbound 5/23 真材料 (PDF+MP4): LLM 取标题+学科, upsert subject_nodes, 写 materials/graph_nodes
 *
 * 全程禁用关键词/正则/写死学科. 学科归类由 penguin-main LLM 输出.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';

// === 1. 路径 + 配置 ===

const REPO = '/root/.openclaw/workspace';
const KIVO_DIR = path.join(REPO, 'projects/kivo');
const DB_PATH = path.join(KIVO_DIR, 'kivo.db');
const UPLOADS_ROOT = path.join(KIVO_DIR, 'uploads/wiki-materials');
const INBOUND_DIR = '/root/.openclaw/media/inbound';
const CONFIG_PATH = '/root/.openclaw/openclaw.json';

// 5/23 真材料: 用 mtime 在 5/22 23:00 ~ 5/24 00:00 之间筛 (覆盖 5/23 全天 + 跨夜文件)
const MTIME_MIN = new Date('2026-05-22T23:00:00+08:00').getTime();
const MTIME_MAX = new Date('2026-05-24T00:00:00+08:00').getTime();

const TARGET_EXT = new Set(['.pdf', '.mp4']);

const PLACEHOLDER_IDS = [
  'e6cc2b01-7282-4ac1-aec8-1a561839ce16',
  '8355df1f-4d74-46d1-a6a5-8dfc4381367c',
  'f9a032ac-4e98-4573-a708-e4dcf69d54ed',
];

const ORPHAN_PROBSTAT_PATTERNS = [
  // entry_id LIKE patterns
  'kivo-wiki-probstat-%',
  'wiki-space-probstat',
];

// === 2. LLM 客户端 (内联, 不依赖 web 模块) ===

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const provider = cfg?.models?.providers?.['penguin-main'];
if (!provider?.baseUrl || !provider?.apiKey) {
  console.error('FATAL: penguin-main provider missing baseUrl/apiKey');
  process.exit(2);
}
const PENGUIN_BASE = provider.baseUrl.replace(/\/$/, '');
const PENGUIN_KEY = provider.apiKey;
const MODEL = process.env.KIVO_LLM_MODEL || 'claude-opus-4-6';

async function chatJson(messages, opts = {}) {
  const url = `${PENGUIN_BASE}/v1/chat/completions`;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PENGUIN_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model || MODEL,
        messages,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 600,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`LLM HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const parsed = JSON.parse(txt);
  const content = parsed?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty LLM content');
  // 解析 JSON: 直接 / fenced / 第一个 {...}
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch { return null; }
  };
  let obj = tryParse(content.trim());
  if (!obj) {
    const f = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (f) obj = tryParse(f[1].trim());
  }
  if (!obj) {
    const start = content.indexOf('{');
    if (start >= 0) {
      let depth = 0;
      for (let i = start; i < content.length; i++) {
        if (content[i] === '{') depth++;
        else if (content[i] === '}') {
          depth--;
          if (depth === 0) {
            obj = tryParse(content.slice(start, i + 1));
            break;
          }
        }
      }
    }
  }
  if (!obj) throw new Error(`Cannot parse LLM JSON: ${content.slice(0, 200)}`);
  return { data: obj, usage: parsed.usage };
}

// === 3. 内容预览提取 ===

function extractPdfText(filePath) {
  try {
    const out = execSync(
      `pdftotext -l 2 -nopgbrk -enc UTF-8 ${JSON.stringify(filePath)} -`,
      { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 },
    ).toString('utf-8');
    // 保留有信息量的字符, 截到 3000
    const cleaned = out.replace(/\s+/g, ' ').trim();
    return cleaned.slice(0, 3000);
  } catch (err) {
    return '';
  }
}

function extractMp4Meta(filePath) {
  try {
    const out = execSync(
      `ffprobe -v error -show_format -show_streams -of json ${JSON.stringify(filePath)}`,
      { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 },
    ).toString('utf-8');
    const data = JSON.parse(out);
    const fmt = data.format || {};
    const dur = fmt.duration ? `${Math.round(parseFloat(fmt.duration))}s` : 'unknown';
    const size = fmt.size ? `${Math.round(parseInt(fmt.size, 10) / 1024 / 1024)}MB` : 'unknown';
    const tags = fmt.tags || {};
    const title = tags.title || tags.TITLE || '';
    return `duration=${dur} size=${size} title="${title}"`;
  } catch {
    return '';
  }
}

// === 4. LLM prompt: 标题 + 学科 ===

async function llmDescribe(filename, ext, preview, fileSize) {
  const system = [
    'You are a knowledge ingestion classifier for KIVO.',
    'Output STRICT JSON ONLY (no prose, no markdown fences, no explanations outside JSON).',
    'Keep ALL string fields SHORT. Total JSON must be < 600 characters.',
    'Schema:',
    '  - title: clean Chinese title, ≤ 40 chars. Derive from preview content; if preview empty, infer from filename hint.',
    '  - subjectName: subject domain in Chinese, ≤ 20 chars (e.g., "AI Agent 产品研究", "概率论与数理统计").',
    '  - subjectLevel: 0 (broad) or 1 (specialized). Default 1.',
    '  - parentName: L0 parent if subjectLevel=1, else null. ≤ 20 chars.',
    '  - summary: ≤ 50 Chinese chars.',
    '  - confidence: 0~1.',
    '  - reason: ≤ 30 Chinese chars. NEVER include quotes inside this field.',
    'NEVER fabricate; if preview is empty, lower confidence and keep reason terse.',
  ].join('\n');

  const user = [
    `【文件名(可能乱码)】 ${filename}`,
    `【扩展名】 ${ext}`,
    `【大小】 ${fileSize} bytes`,
    `【内容预览】`,
    preview || '(empty preview)',
    '',
    '请输出 JSON.',
  ].join('\n');

  const { data } = await chatJson(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0, maxTokens: 1500 },
  );
  return data;
}

// === 5. DB 操作 ===

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

function ensureUploadDir() {
  fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
}

function deleteOrphanGraphNodes() {
  const before = db.prepare(
    `SELECT COUNT(*) AS n FROM graph_nodes
     WHERE (entry_id LIKE 'kivo-wiki-probstat-%' OR entry_id = 'wiki-space-probstat')`,
  ).get();
  const stmt = db.prepare(
    `DELETE FROM graph_nodes
     WHERE (entry_id LIKE 'kivo-wiki-probstat-%' OR entry_id = 'wiki-space-probstat')`,
  );
  const r = stmt.run();
  return { matched: before.n, deleted: r.changes };
}

function deletePlaceholderMaterials() {
  const out = [];
  for (const id of PLACEHOLDER_IDS) {
    const row = db.prepare('SELECT id, storage_path FROM materials WHERE id = ?').get(id);
    if (!row) {
      out.push({ id, status: 'not_found' });
      continue;
    }
    if (row.storage_path) {
      try { fs.unlinkSync(row.storage_path); } catch { /* ignore */ }
    }
    db.prepare('DELETE FROM materials WHERE id = ?').run(id);
    out.push({ id, status: 'deleted', storage_path: row.storage_path || null });
  }
  return out;
}

function findOrCreateSubjectNode({ name, level, parentName }) {
  const cleanName = (name || '').trim();
  if (!cleanName) throw new Error('subject name empty');
  const wantLevel = level === 0 ? 0 : 1;

  // 找同名同 level
  const existing = db.prepare(
    `SELECT id, parent_id, name, level FROM subject_nodes
     WHERE name = ? AND level = ? AND (status IS NULL OR status='active') AND (merged_into IS NULL OR merged_into='')
     ORDER BY created_at ASC LIMIT 1`,
  ).get(cleanName, wantLevel);
  if (existing) return existing.id;

  // 解析 parent_id (仅 L1 需要)
  let parentId = null;
  if (wantLevel === 1 && parentName) {
    const parent = db.prepare(
      `SELECT id FROM subject_nodes
       WHERE name = ? AND level = 0 AND (status IS NULL OR status='active')
       ORDER BY created_at ASC LIMIT 1`,
    ).get(parentName.trim());
    if (parent) {
      parentId = parent.id;
    } else {
      // 自动建一个 L0 父
      const pid = crypto.randomUUID();
      db.prepare(
        `INSERT INTO subject_nodes (id, parent_id, name, tree_kind, origin, created_at, level, status)
         VALUES (?, NULL, ?, 'subject', 'auto', ?, 0, 'active')`,
      ).run(pid, parentName.trim(), Date.now());
      parentId = pid;
    }
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO subject_nodes (id, parent_id, name, tree_kind, origin, created_at, level, status)
     VALUES (?, ?, ?, 'subject', 'auto', ?, ?, 'active')`,
  ).run(id, parentId, cleanName, Date.now(), wantLevel);
  return id;
}

function safeFileName(name) {
  return name.replace(/[\/\\\0]/g, '_').slice(0, 200);
}

function importOneMaterial({ srcPath, fileName, fileSize, mimeType, assetKind, llm }) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();

  // 用 LLM 给的 title 做 storage_path 文件名(带 uuid 前缀)
  const safeTitle = safeFileName(`${llm.title || fileName}.${assetKind}`);
  const storagePath = path.join(UPLOADS_ROOT, `${id}-${safeTitle}`);
  fs.copyFileSync(srcPath, storagePath);

  const subjectNodeId = findOrCreateSubjectNode({
    name: llm.subjectName,
    level: llm.subjectLevel === 0 ? 0 : 1,
    parentName: llm.parentName,
  });

  const conf = typeof llm.confidence === 'number'
    ? Math.max(0, Math.min(1, llm.confidence))
    : 0.7;
  const status = conf >= 0.7 ? 'classified' : 'pending_classification';

  db.prepare(`
    INSERT INTO materials (
      id, file_name, mime_type, file_size, status,
      space_id, wiki_page_count, created_at, updated_at,
      storage_path, wiki_page_ids_json, error_message,
      subject_node_id, classification_status, classification_confidence,
      suggested_subject_name, asset_kind, source_channel, source_ref,
      classification_reason, pipeline_status, slice_count, extract_count, inject_count
    ) VALUES (
      @id, @fileName, @mimeType, @fileSize, 'ready',
      'default', 0, @createdAt, @updatedAt,
      @storagePath, '[]', NULL,
      @subjectNodeId, @cstatus, @conf,
      @suggested, @assetKind, 'inbound', @sourceRef,
      @reason, 'pending', 0, 0, 0
    )
  `).run({
    id,
    fileName: llm.title ? `${llm.title}.${assetKind}` : fileName,
    mimeType: mimeType || 'application/octet-stream',
    fileSize,
    createdAt: ts,
    updatedAt: ts,
    storagePath,
    subjectNodeId: status === 'classified' ? subjectNodeId : null,
    cstatus: status,
    conf,
    suggested: llm.subjectName || null,
    assetKind,
    sourceRef: `inbound://${path.basename(srcPath)}`,
    reason: (llm.reason || '').slice(0, 500),
  });

  // 写 graph_nodes (material 类型)
  db.prepare(`
    INSERT INTO graph_nodes (entry_id, type, title, domain, tags_json, created_at)
    VALUES (?, 'material', ?, ?, '[]', datetime('now'))
  `).run(`material-${id}`, llm.title || fileName, llm.subjectName || null);

  return {
    materialId: id,
    title: llm.title || fileName,
    subjectNodeId,
    subjectName: llm.subjectName,
    confidence: conf,
    status,
    storagePath,
  };
}

// === 6. 主流程 ===

async function main() {
  ensureUploadDir();
  const summary = {
    startedAt: new Date().toISOString(),
    orphan_graph_nodes: null,
    placeholder_materials: null,
    imports: [],
    errors: [],
  };

  // (1) 清孤儿 graph_nodes
  console.log('\n=== [1/3] 清 probstat 孤儿 graph_nodes ===');
  const orphan = deleteOrphanGraphNodes();
  summary.orphan_graph_nodes = orphan;
  console.log(JSON.stringify(orphan));

  // (2) 删占位
  console.log('\n=== [2/3] 删 3 条占位 materials ===');
  const placeholders = deletePlaceholderMaterials();
  summary.placeholder_materials = placeholders;
  console.log(JSON.stringify(placeholders, null, 2));

  // (3) 扫 inbound + 导入
  console.log('\n=== [3/3] 扫描 + 导入 inbound 真材料 ===');
  const allFiles = fs.readdirSync(INBOUND_DIR);
  const targets = [];
  for (const fn of allFiles) {
    const ext = path.extname(fn).toLowerCase();
    if (!TARGET_EXT.has(ext)) continue;
    const full = path.join(INBOUND_DIR, fn);
    const st = fs.statSync(full);
    if (st.mtimeMs < MTIME_MIN || st.mtimeMs >= MTIME_MAX) continue;
    targets.push({ full, fn, ext, size: st.size });
  }
  console.log(`扫到 ${targets.length} 份候选(5/23 时段, 含 PDF/MP4)`);

  for (const t of targets) {
    const ext = t.ext.replace('.', '');
    const assetKind = ext === 'pdf' ? 'pdf' : ext === 'mp4' ? 'video' : 'other';
    const mimeType = ext === 'pdf' ? 'application/pdf' : 'video/mp4';

    // 幂等: 已按此 source_ref 导入过则跳过
    const existing = db.prepare(
      `SELECT id, file_name, classification_status FROM materials WHERE source_ref = ? LIMIT 1`,
    ).get(`inbound://${t.fn}`);
    if (existing) {
      console.log(`◇ 已存在, 跳过: ${t.fn} (id=${existing.id})`);
      summary.imports.push({
        materialId: existing.id,
        title: existing.file_name,
        status: existing.classification_status,
        source_file: t.fn,
        skipped: true,
      });
      continue;
    }

    let preview = '';
    if (ext === 'pdf') preview = extractPdfText(t.full);
    else if (ext === 'mp4') preview = extractMp4Meta(t.full);

    let llm;
    try {
      llm = await llmDescribe(t.fn, ext, preview, t.size);
    } catch (err) {
      summary.errors.push({ file: t.fn, stage: 'llm', error: String(err) });
      console.error(`× LLM 失败: ${t.fn} -> ${err}`);
      continue;
    }

    try {
      const r = importOneMaterial({
        srcPath: t.full,
        fileName: t.fn,
        fileSize: t.size,
        mimeType,
        assetKind,
        llm,
      });
      summary.imports.push({ ...r, source_file: t.fn });
      console.log(`✓ ${r.title} → ${r.subjectName} (conf=${r.confidence.toFixed(2)})`);
    } catch (err) {
      summary.errors.push({ file: t.fn, stage: 'import', error: String(err) });
      console.error(`× 写库失败: ${t.fn} -> ${err}`);
    }
  }

  summary.finishedAt = new Date().toISOString();
  const out = path.join(REPO, 'reports/kivo-batch1-import-summary.json');
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nSummary written: ${out}`);

  db.close();
  return summary;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
