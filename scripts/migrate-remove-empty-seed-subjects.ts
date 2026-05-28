import { copyFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const DEFAULT_BACKUP_NAME = 'kivo.db.bak.before-seed-cleanup-20260524';
const ATOMIC_ENTRY_TYPES = ['fact', 'methodology', 'decision', 'experience'];

interface SubjectNodeRow {
  id: string;
  name: string;
}

interface CountRow {
  count: number;
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function getCount(db: Database.Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as CountRow | undefined;
  return row?.count ?? 0;
}

function entryCountForSubject(db: Database.Database, subjectId: string): number {
  const placeholders = ATOMIC_ENTRY_TYPES.map(() => '?').join(', ');
  return getCount(
    db,
    `SELECT COUNT(*) AS count
       FROM entries
      WHERE subject_id = ?
        AND type IN (${placeholders})
        AND COALESCE(status, 'active') != 'deleted'`,
    subjectId,
    ...ATOMIC_ENTRY_TYPES,
  );
}

function deleteCompiledWikiPages(db: Database.Database, subjectId: string): number {
  const ids = db.prepare(`
    SELECT id
      FROM entries
     WHERE type = 'wiki_page'
       AND subject_id = ?
       AND (
         metadata_json LIKE ?
         OR source_json LIKE ?
       )
  `).all(subjectId, `%"subjectNodeId":"${subjectId}"%`, `%"subject_node_id":"${subjectId}"%`) as Array<{ id: string }>;

  const legacyIds = db.prepare(`
    SELECT id
      FROM entries
     WHERE type = 'wiki_page'
       AND subject_id = ?
       AND (
         COALESCE(metadata_json, '') = '{}'
         OR COALESCE(source_json, '') = '{}'
       )
  `).all(subjectId) as Array<{ id: string }>;

  const pageIds = Array.from(new Set([...ids, ...legacyIds].map((row) => row.id)));
  if (pageIds.length === 0) return 0;

  const deleteLinks = db.prepare(`DELETE FROM wiki_links WHERE source_page_id = ? OR target_page_id = ?`);
  const deleteVersions = db.prepare(`DELETE FROM wiki_page_versions WHERE page_id = ?`);
  const deleteEntry = db.prepare(`DELETE FROM entries WHERE id = ? AND type = 'wiki_page'`);

  for (const id of pageIds) {
    deleteLinks.run(id, id);
    deleteVersions.run(id);
    deleteEntry.run(id);
  }

  return pageIds.length;
}

function resolveBackupPath(rawPath: string): string {
  const target = resolve(rawPath);
  if (!existsSync(target)) return target;

  const dir = dirname(target);
  const name = basename(target);
  let index = 1;
  while (true) {
    const candidate = join(dir, `${name}.${index}`);
    if (!existsSync(candidate)) return candidate;
    index += 1;
  }
}

function purgeGlobalEmptyShellPages(db: Database.Database): number {
  const rows = db.prepare(`
    SELECT id
      FROM entries
     WHERE type = 'wiki_page'
       AND length(COALESCE(content, '')) = 0
       AND (
         COALESCE(metadata_json, '') = '{}'
         OR metadata_json IS NULL
       )
  `).all() as Array<{ id: string }>;

  if (rows.length === 0) return 0;

  const deleteLinks = db.prepare(`DELETE FROM wiki_links WHERE source_page_id = ? OR target_page_id = ?`);
  const deleteVersions = db.prepare(`DELETE FROM wiki_page_versions WHERE page_id = ?`);
  const deleteEntry = db.prepare(`DELETE FROM entries WHERE id = ? AND type = 'wiki_page'`);

  for (const row of rows) {
    deleteLinks.run(row.id, row.id);
    deleteVersions.run(row.id);
    deleteEntry.run(row.id);
  }

  return rows.length;
}

export function runSeedCleanup(dbPath: string, backupPath: string): {
  deletedSubjects: number;
  deletedPages: number;
  globalShellPages: number;
} {
  if (!existsSync(dbPath)) {
    throw new Error(`DB not found: ${dbPath}`);
  }

  copyFileSync(dbPath, backupPath);
  console.log(`[seed-cleanup] backup created: ${backupPath}`);

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');

  try {
    const subjects = db.prepare(`
      SELECT id, name
        FROM subject_nodes
       WHERE merged_into IS NULL
       ORDER BY level ASC, name ASC
    `).all() as SubjectNodeRow[];

    let deletedSubjects = 0;
    let deletedPages = 0;
    let globalShellPages = 0;
    const cleaned: string[] = [];

    const tx = db.transaction(() => {
      for (const subject of subjects) {
        const count = entryCountForSubject(db, subject.id);
        if (count > 0) {
          console.log(`[seed-cleanup] keep: ${subject.name} (${subject.id}) entries=${count}`);
          continue;
        }

        const pageCount = deleteCompiledWikiPages(db, subject.id);
        db.prepare(`DELETE FROM subject_nodes WHERE id = ?`).run(subject.id);
        deletedSubjects += 1;
        deletedPages += pageCount;
        cleaned.push(`${subject.name} (${subject.id}) wiki_pages=${pageCount}`);
        console.log(`[seed-cleanup] delete: ${subject.name} (${subject.id}) entries=0 wiki_pages=${pageCount}`);
      }

      // 全局清理：覆盖保留节点下/孤儿挂载的占位 wiki_page。
      // spec FR-2 AC4「已存在的占位 wiki_page entries 在迁移脚本中清理」未限定挂载节点。
      globalShellPages = purgeGlobalEmptyShellPages(db);
    });

    tx();

    console.log(`[seed-cleanup] deleted subject_nodes: ${deletedSubjects}`);
    console.log(`[seed-cleanup] deleted wiki_page entries (per-subject): ${deletedPages}`);
    console.log(`[seed-cleanup] purged global empty wiki_page shells: ${globalShellPages}`);
    if (cleaned.length > 0) {
      console.log('[seed-cleanup] cleaned nodes:');
      for (const line of cleaned) console.log(`  - ${line}`);
    }

    return { deletedSubjects, deletedPages, globalShellPages };
  } finally {
    db.close();
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const dbPath = resolve(getArg(args, '--db') ?? 'kivo.db');
  const backupPath = resolveBackupPath(getArg(args, '--backup') ?? DEFAULT_BACKUP_NAME);
  runSeedCleanup(dbPath, backupPath);
}

if (process.argv[1] && process.argv[1].includes('migrate-remove-empty-seed-subjects')) {
  main();
}
