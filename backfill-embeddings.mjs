/**
 * Backfill embeddings for entries that don't have them.
 * Uses Ollama BGE-M3 model locally.
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const DB_PATH = resolve('/root/.openclaw/workspace/projects/kivo/kivo.db');
const OLLAMA_URL = 'http://localhost:11434/api/embeddings';
const MODEL = 'bge-m3';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const rows = db.prepare(
  "SELECT id, title, content FROM entries WHERE status = 'active' AND embedding IS NULL"
).all();

console.log(`Found ${rows.length} entries without embeddings. Backfilling...`);

let success = 0;
let failed = 0;

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const text = `${row.title}\n${row.content}`.slice(0, 2000);
  
  try {
    const resp = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: text }),
    });
    
    if (!resp.ok) {
      console.error(`  [${i+1}/${rows.length}] Failed for "${row.title.slice(0,40)}": HTTP ${resp.status}`);
      failed++;
      continue;
    }
    
    const data = await resp.json();
    const embedding = data.embedding;
    
    if (!embedding || !Array.isArray(embedding)) {
      console.error(`  [${i+1}/${rows.length}] No embedding returned for "${row.title.slice(0,40)}"`);
      failed++;
      continue;
    }
    
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    db.prepare('UPDATE entries SET embedding = ? WHERE id = ?').run(buffer, row.id);
    success++;
    
    if ((i + 1) % 20 === 0) {
      console.log(`  Progress: ${i+1}/${rows.length} (${success} ok, ${failed} failed)`);
    }
  } catch (err) {
    console.error(`  [${i+1}/${rows.length}] Error for "${row.title.slice(0,40)}": ${err.message}`);
    failed++;
  }
}

db.close();
console.log(`\nDone. Success: ${success}, Failed: ${failed}, Total: ${rows.length}`);
