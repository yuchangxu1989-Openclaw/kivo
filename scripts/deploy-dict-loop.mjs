#!/usr/bin/env node
/**
 * KIVO 词典自动闭环 — 部署脚本
 *
 * 执行：node projects/kivo/scripts/deploy-dict-loop.mjs
 *
 * 1. 替换 handler.js symlink → handler-v2.js
 * 2. 补全 system-dictionary 条目的 embedding
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, '..', '..', '..');
const KIVO_ROOT = path.resolve(__dirname, '..');

// --- Step 1: Deploy handler-v2.js ---

function deployHandler() {
  const symlink = path.join(WORKSPACE, 'hooks', 'kivo-intent-injection', 'handler.js');
  const source = path.join(KIVO_ROOT, 'assets', 'hook', 'handler-v2.js');

  if (!fs.existsSync(source)) {
    console.error('[deploy] handler-v2.js not found at:', source);
    return false;
  }

  try {
    const stat = fs.lstatSync(symlink);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(symlink);
      console.log('[deploy] Removed old symlink');
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('[deploy] Cannot remove old handler:', e.message);
      return false;
    }
  }

  fs.copyFileSync(source, symlink);
  console.log('[deploy] Deployed handler-v2.js → hooks/kivo-intent-injection/handler.js');
  return true;
}

// --- Step 2: Backfill embeddings for system-dictionary ---

const OLLAMA_URL = 'http://localhost:11434/api/embeddings';
const MODEL = 'bge-m3';

async function backfillDictEmbeddings() {
  const dbPath = path.join(KIVO_ROOT, 'kivo.db');
  if (!fs.existsSync(dbPath)) {
    console.error('[backfill] kivo.db not found at:', dbPath);
    return false;
  }

  const { default: Database } = await import(path.join(KIVO_ROOT, 'node_modules', 'better-sqlite3', 'lib', 'index.js'));
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const rows = db.prepare(
    "SELECT id, title, content FROM entries WHERE domain = 'system-dictionary' AND status = 'active' AND (embedding IS NULL OR length(embedding) = 0)"
  ).all();

  if (rows.length === 0) {
    console.log('[backfill] All dictionary entries already have embeddings');
    db.close();
    return true;
  }

  console.log(`[backfill] Found ${rows.length} dictionary entries without embeddings`);

  let success = 0;
  for (const row of rows) {
    const text = `${row.title}\n${row.content}`.slice(0, 2000);
    try {
      const resp = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, prompt: text }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) { console.error(`  [${row.title}] HTTP ${resp.status}`); continue; }
      const data = await resp.json();
      if (!data.embedding || !Array.isArray(data.embedding)) { console.error(`  [${row.title}] No embedding`); continue; }
      const buffer = Buffer.from(new Float32Array(data.embedding).buffer);
      db.prepare('UPDATE entries SET embedding = ? WHERE id = ?').run(buffer, row.id);
      success++;
      console.log(`  [${row.title}] OK (dim=${data.embedding.length})`);
    } catch (err) { console.error(`  [${row.title}] ${err.message}`); }
  }

  db.close();
  console.log(`[backfill] Done: ${success}/${rows.length} embeddings generated`);
  return success === rows.length;
}

// --- Step 3: Verify ---

async function verify() {
  const dbPath = path.join(KIVO_ROOT, 'kivo.db');
  const { default: Database } = await import(path.join(KIVO_ROOT, 'node_modules', 'better-sqlite3', 'lib', 'index.js'));
  const db = new Database(dbPath, { readonly: true });
  const count = db.prepare("SELECT COUNT(*) as n FROM entries WHERE domain = 'system-dictionary' AND length(embedding) = 4096").get();
  db.close();
  console.log(`[verify] Dictionary entries with valid embedding: ${count.n}`);
  return count.n >= 4;
}

// --- Main ---

async function main() {
  console.log('=== KIVO 词典自动闭环部署 ===\n');

  console.log('Step 1: Deploy handler-v2.js');
  deployHandler();

  console.log('\nStep 2: Backfill dictionary embeddings');
  await backfillDictEmbeddings();

  console.log('\nStep 3: Verify');
  const ok = await verify();
  console.log(ok ? '\n✓ 部署完成' : '\n⚠ 部分步骤未完成，请检查 Ollama 是否运行');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
