/**
 * FR-P04 + FR-P06 backfill 脚本
 *
 *   1. 扫 materials WHERE subject_node_id IS NOT NULL（PDF only，跳过 video）
 *   2. 对每份 material 调 SubjectConceptExtractor.extractFromMaterial
 *      - 已有 ≥5 旧 entries 的 PDF：用旧 entries content 拼回作为 chunks（快）
 *      - 没有旧 entries 的 PDF：重新 parsePdf 切片
 *   3. 跑完后调 WikiPageCompiler.compileAll() 触发 FR-P06 聚合
 *   4. 写 wiki_page + wiki_links + wiki_page_versions
 *   5. 输出实测 DB diff（对比脚本启动前的 baseline）
 *
 * Usage:
 *   npx tsx scripts/backfill-p04-p06-extract.ts [--db <path>] [--material <id>] [--skip-pdf-reparse]
 *
 * Hermes (OpenClaw ACP Agent) / 2026-05-24
 */

import { resolve } from 'node:path';
import Database from 'better-sqlite3';

import { SubjectConceptExtractor } from '../src/wiki/compiler/subject-concept-extractor.js';
import { WikiPageCompiler } from '../src/wiki/compiler/wiki-page-compiler.js';

interface Args {
  dbPath: string;
  materialFilter?: string;
  skipPdfReparse: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const dbPath = pickArg(argv, '--db') ?? resolve(process.cwd(), 'kivo.db');
  const materialFilter = pickArg(argv, '--material');
  const skipPdfReparse = argv.includes('--skip-pdf-reparse');
  return { dbPath, materialFilter, skipPdfReparse };
}

function pickArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

interface MaterialRow {
  id: string;
  file_name: string;
  subject_node_id: string;
  mime_type: string;
  has_old_entries: number;
}

interface DbCounts {
  entries_total: number;
  entries_concept_type: number;
  entries_method_type: number;
  entries_question_type: number;
  entries_mistake_type: number;
  entries_annotation_type: number;
  wiki_pages: number;
  wiki_links: number;
  wiki_page_versions: number;
}

function snapshotCounts(db: Database.Database): DbCounts {
  const get = (sql: string): number => {
    const row = db.prepare(sql).get() as { c?: number } | undefined;
    return row?.c ?? 0;
  };
  return {
    entries_total: get(`SELECT COUNT(*) AS c FROM entries`),
    entries_concept_type: get(`SELECT COUNT(*) AS c FROM entries WHERE entry_type='concept'`),
    entries_method_type: get(`SELECT COUNT(*) AS c FROM entries WHERE entry_type='method'`),
    entries_question_type: get(`SELECT COUNT(*) AS c FROM entries WHERE entry_type='question'`),
    entries_mistake_type: get(`SELECT COUNT(*) AS c FROM entries WHERE entry_type='mistake'`),
    entries_annotation_type: get(`SELECT COUNT(*) AS c FROM entries WHERE entry_type='annotation'`),
    wiki_pages: get(`SELECT COUNT(*) AS c FROM entries WHERE type='wiki_page'`),
    wiki_links: get(`SELECT COUNT(*) AS c FROM wiki_links`),
    wiki_page_versions: get(`SELECT COUNT(*) AS c FROM wiki_page_versions`),
  };
}

function diffCounts(before: DbCounts, after: DbCounts): Array<[keyof DbCounts, number, number, number]> {
  const keys = Object.keys(before) as Array<keyof DbCounts>;
  return keys.map((key) => [key, before[key], after[key], after[key] - before[key]]);
}

function selectMaterials(db: Database.Database, filter: string | undefined): MaterialRow[] {
  const baseSql = `
    SELECT m.id, m.file_name, m.subject_node_id, m.mime_type,
      (
        SELECT COUNT(*)
        FROM entries e
        WHERE e.type IN ('fact','methodology','decision','experience')
          AND COALESCE(e.status,'active') != 'deleted'
          AND json_extract(e.source_json,'$.materialId') = m.id
      ) AS has_old_entries
    FROM materials m
    WHERE m.subject_node_id IS NOT NULL
      AND m.mime_type = 'application/pdf'
  `;
  if (filter) {
    return db.prepare(`${baseSql} AND m.id = ? ORDER BY m.file_name`).all(filter) as MaterialRow[];
  }
  return db.prepare(`${baseSql} ORDER BY m.file_name`).all() as MaterialRow[];
}

async function main() {
  const args = parseArgs();
  console.log(`[backfill] DB: ${args.dbPath}`);
  console.log(`[backfill] material filter: ${args.materialFilter ?? '(all PDFs with subject_node_id)'}`);
  console.log(`[backfill] skipPdfReparse: ${args.skipPdfReparse}`);

  const probeDb = new Database(args.dbPath);
  probeDb.pragma('journal_mode = WAL');
  const before = snapshotCounts(probeDb);
  const materials = selectMaterials(probeDb, args.materialFilter);
  probeDb.close();

  console.log(`[backfill] baseline counts:`, before);
  console.log(`[backfill] materials to process: ${materials.length}`);
  for (const m of materials) {
    console.log(`  - ${m.id} | ${m.file_name} | subject=${m.subject_node_id} | old_entries=${m.has_old_entries}`);
  }

  // ── Part A：调用 SubjectConceptExtractor ─────────────────────────────────
  const extractor = new SubjectConceptExtractor(args.dbPath, { verbose: true });
  let totalChunks = 0;
  let totalItems = 0;
  let totalEntriesWritten = 0;
  const perMaterial: Array<{
    materialId: string;
    fileName: string;
    chunkCount: number;
    itemsExtracted: number;
    entriesWritten: number;
    errors: string[];
  }> = [];

  try {
    for (const material of materials) {
      // 跳过没有旧条目的 PDF（避免 PDF 重 parse 阶段 OOM/慢）
      if (args.skipPdfReparse && material.has_old_entries < 5) {
        console.log(`[backfill] SKIP ${material.id} (${material.file_name}): old entries=${material.has_old_entries}, skipPdfReparse=true`);
        perMaterial.push({
          materialId: material.id,
          fileName: material.file_name,
          chunkCount: 0,
          itemsExtracted: 0,
          entriesWritten: 0,
          errors: ['skipped: skipPdfReparse + insufficient old entries'],
        });
        continue;
      }

      console.log(`\n[backfill] ▶︎ ${material.file_name} (${material.id}) ...`);
      const startedAt = Date.now();
      try {
        const result = await extractor.extractFromMaterial(material.id);
        totalChunks += result.chunkCount;
        totalItems += result.itemsExtracted;
        totalEntriesWritten += result.entriesWritten;
        perMaterial.push({
          materialId: material.id,
          fileName: material.file_name,
          chunkCount: result.chunkCount,
          itemsExtracted: result.itemsExtracted,
          entriesWritten: result.entriesWritten,
          errors: result.errors,
        });
        console.log(
          `[backfill]   chunks=${result.chunkCount} items=${result.itemsExtracted} entries_written=${result.entriesWritten} errors=${result.errors.length} elapsed=${(Date.now() - startedAt) / 1000}s`,
        );
        if (result.errors.length > 0) {
          for (const err of result.errors.slice(0, 5)) {
            console.log(`[backfill]     err: ${err}`);
          }
        }
      } catch (error) {
        console.error(`[backfill]   FAILED: ${(error as Error).message}`);
        perMaterial.push({
          materialId: material.id,
          fileName: material.file_name,
          chunkCount: 0,
          itemsExtracted: 0,
          entriesWritten: 0,
          errors: [`fatal: ${(error as Error).message}`],
        });
      }
    }
  } finally {
    extractor.close();
  }

  console.log(
    `\n[backfill] extractor done. totalChunks=${totalChunks} totalItems=${totalItems} totalEntriesWritten=${totalEntriesWritten}`,
  );

  // ── Part B：跑 WikiPageCompiler.compileAll() ─────────────────────────────
  console.log(`\n[backfill] ▶︎ compileAll wiki pages ...`);
  const compiler = new WikiPageCompiler(args.dbPath);
  let compileSummary = '';
  try {
    const startedAt = Date.now();
    const result = await compiler.compileAll();
    compileSummary = `pagesCreated=${result.pagesCreated} pagesUpdated=${result.pagesUpdated} linksCreated=${result.linksCreated} items=${result.items.length} errors=${result.errors.length}`;
    console.log(
      `[backfill] compile done. ${compileSummary} elapsed=${(Date.now() - startedAt) / 1000}s`,
    );
    for (const item of result.items) {
      console.log(
        `[backfill]   page: ${item.title} subjectId=${item.subjectId} entries=${item.entryCount} materials=${item.materialCount}`,
      );
    }
    for (const err of result.errors) {
      console.error(`[backfill]   compile-err: ${err}`);
    }
  } finally {
    compiler.close();
  }

  // ── Part C：DB diff ─────────────────────────────────────────────────────
  const verifyDb = new Database(args.dbPath);
  const after = snapshotCounts(verifyDb);
  verifyDb.close();

  console.log(`\n[backfill] DB diff (before → after = delta):`);
  for (const [key, b, a, d] of diffCounts(before, after)) {
    console.log(`  ${key}: ${b} → ${a}  (${d >= 0 ? '+' : ''}${d})`);
  }

  console.log(`\n[backfill] per-material summary:`);
  for (const row of perMaterial) {
    console.log(
      `  ${row.materialId} | ${row.fileName} | chunks=${row.chunkCount} items=${row.itemsExtracted} written=${row.entriesWritten} errors=${row.errors.length}`,
    );
  }

  console.log(`\n[backfill] DONE.`);
}

main().catch((err) => {
  console.error(`[backfill] FATAL: ${(err as Error).message}`);
  console.error((err as Error).stack);
  process.exit(1);
});
