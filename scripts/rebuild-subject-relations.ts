import Database from 'better-sqlite3';
import path from 'node:path';
import { rebuildSubjectRelationsForDoneMaterials } from '../src/graph/subject-graph-writer.js';

async function main(): Promise<void> {
  const dbPath = path.resolve(process.cwd(), 'kivo.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  try {
    const result = await rebuildSubjectRelationsForDoneMaterials(db, {
      materialLimit: 4,
      topK: 8,
      concurrency: 6,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
