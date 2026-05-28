#!/usr/bin/env -S npx tsx
/**
 * cleanup-test-fixture-pollution.ts
 *
 * 清掉历史 vitest 漏隔离泄漏到 prod kivo.db 的测试 fixture：
 *   - entries 表里 id LIKE 'term-web-%' 且 content 不含中文（双重保险）
 *   - dictionary_terms 表里同名 id（如有）
 *   - graph_edges 表里 source_id / target_id 命中上述 id 的边
 *
 * 该脚本幂等。运行前自动备份到 kivo.db.bak.cleanup-fixture-<ts>。
 *
 * 用法：
 *   cd projects/kivo
 *   npx tsx scripts/cleanup-test-fixture-pollution.ts          # 真删
 *   npx tsx scripts/cleanup-test-fixture-pollution.ts --dry    # 只盘点,不删
 *   npx tsx scripts/cleanup-test-fixture-pollution.ts --db /path/to/other.db
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

interface Args {
  dry: boolean;
  dbPath: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let dbPath = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), 'kivo.db');
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry' || a === '--dry-run') dry = true;
    else if (a === '--db' && argv[i + 1]) {
      dbPath = path.resolve(argv[++i]);
    }
  }
  return { dry, dbPath };
}

function ts(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { 1: number } | undefined;
  return !!row;
}

function main(): void {
  const args = parseArgs();
  if (!fs.existsSync(args.dbPath)) {
    console.error(`[cleanup] DB not found: ${args.dbPath}`);
    process.exit(1);
  }

  console.log(`[cleanup] target DB: ${args.dbPath}`);
  console.log(`[cleanup] mode: ${args.dry ? 'DRY-RUN' : 'APPLY'}`);

  if (!args.dry) {
    const backup = `${args.dbPath}.bak.cleanup-fixture-${ts()}`;
    fs.copyFileSync(args.dbPath, backup);
    console.log(`[cleanup] backup created: ${backup}`);
  }

  const db = new Database(args.dbPath);
  try {
    db.pragma('foreign_keys = OFF');

    // 1) 盘点 entries 表里命中的 fixture
    //    条件：id LIKE 'term-web-%' AND content NOT GLOB '*[一-龥]*'
    //    GLOB '[一-龥]' 在 better-sqlite3 默认 ICU 关闭时不可靠,改成正则 LIKE 多级
    //    保险写法：用 length(content) > 0 AND content NOT REGEXP 中文字符
    //    sqlite 默认无 REGEXP；fallback 到 instr 检测常见中文字符不可行
    //    最终方案：`hex(content) NOT LIKE '%E4%' AND hex(content) NOT LIKE '%E5%' ...` 太脆
    //    实际上 GLOB 的字符范围在 SQLite 是 byte-level 的,'[一-龥]' 不会按字符工作。
    //    采用更直接的方案：扫描所有 term-web-% 条目,在 JS 层判定是否含中文。
    const candidates = db
      .prepare(
        `SELECT id, type, title, substr(content, 1, 80) AS content_preview, status, deleted_at
         FROM entries
         WHERE id LIKE 'term-web-%'`,
      )
      .all() as Array<{
      id: string;
      type: string | null;
      title: string;
      content_preview: string;
      status: string;
      deleted_at: string | null;
    }>;

    const HAN = /[\u4e00-\u9fff]/;
    const toDelete = candidates.filter((row) => !HAN.test(row.content_preview ?? ''));
    const skipped = candidates.filter((row) => HAN.test(row.content_preview ?? ''));

    console.log(`[cleanup] entries hit total: ${candidates.length}`);
    console.log(`[cleanup]   to delete (no Chinese in content): ${toDelete.length}`);
    console.log(`[cleanup]   skipped (contains Chinese):       ${skipped.length}`);

    if (toDelete.length > 0) {
      const sample = toDelete.slice(0, 5).map((r) => `${r.id}|${r.title}|${r.content_preview}`);
      console.log('[cleanup]   sample IDs:');
      for (const s of sample) console.log(`     ${s}`);
    }

    // 2) dictionary_terms 表里 id 同名
    let dictHits: Array<{ id: string; term: string }> = [];
    if (tableExists(db, 'dictionary_terms')) {
      dictHits = db
        .prepare(
          `SELECT id, term FROM dictionary_terms WHERE id LIKE 'term-web-%'`,
        )
        .all() as Array<{ id: string; term: string }>;
      console.log(`[cleanup] dictionary_terms hit: ${dictHits.length}`);
    } else {
      console.log('[cleanup] dictionary_terms table not present, skipping');
    }

    // 3) graph_edges 表里 source_id / target_id 命中
    let edgeHits = 0;
    if (tableExists(db, 'graph_edges')) {
      const edgeRow = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM graph_edges
           WHERE source_id LIKE 'term-web-%' OR target_id LIKE 'term-web-%'`,
        )
        .get() as { cnt: number };
      edgeHits = edgeRow.cnt;
      console.log(`[cleanup] graph_edges hit: ${edgeHits}`);
    } else {
      console.log('[cleanup] graph_edges table not present, skipping');
    }

    if (args.dry) {
      console.log('[cleanup] DRY-RUN complete; no changes written.');
      return;
    }

    if (toDelete.length === 0 && dictHits.length === 0 && edgeHits === 0) {
      console.log('[cleanup] nothing to clean. DB is already pristine.');
      return;
    }

    // Apply deletes inside a transaction
    const txn = db.transaction(() => {
      let deletedEntries = 0;
      const delEntry = db.prepare(`DELETE FROM entries WHERE id = ?`);
      for (const row of toDelete) {
        const r = delEntry.run(row.id);
        deletedEntries += r.changes;
      }

      let deletedDict = 0;
      if (tableExists(db, 'dictionary_terms')) {
        const delDict = db.prepare(`DELETE FROM dictionary_terms WHERE id = ?`);
        for (const row of dictHits) {
          const r = delDict.run(row.id);
          deletedDict += r.changes;
        }
      }

      let deletedEdges = 0;
      if (tableExists(db, 'graph_edges')) {
        const r = db
          .prepare(
            `DELETE FROM graph_edges
             WHERE source_id LIKE 'term-web-%' OR target_id LIKE 'term-web-%'`,
          )
          .run();
        deletedEdges = r.changes;
      }

      return { deletedEntries, deletedDict, deletedEdges };
    });

    const result = txn();
    console.log(`[cleanup] APPLY done:`);
    console.log(`[cleanup]   entries deleted:          ${result.deletedEntries}`);
    console.log(`[cleanup]   dictionary_terms deleted: ${result.deletedDict}`);
    console.log(`[cleanup]   graph_edges deleted:      ${result.deletedEdges}`);

    // Try to rebuild FTS index if entries_fts exists
    if (tableExists(db, 'entries_fts')) {
      try {
        db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`);
        console.log('[cleanup] entries_fts index rebuilt');
      } catch (e) {
        console.warn('[cleanup] entries_fts rebuild skipped:', (e as Error).message);
      }
    }
  } finally {
    db.close();
  }
}

main();
