import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';

export interface DeleteOptions {
  force?: boolean;
  json?: boolean;
}

export async function runDelete(id: string, options: DeleteOptions = {}): Promise<string> {
  if (!id) {
    return 'Usage: kivo delete <id> [--force] [--json]';
  }

  const dir = process.cwd();
  const configPath = join(dir, 'kivo.config.json');

  let dbPath = String(DEFAULT_CONFIG.dbPath);
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }

  const resolvedDb = resolve(dir, dbPath);
  if (!existsSync(resolvedDb)) {
    return 'Database not found. Run "kivo init" first.';
  }

  const db = new Database(resolvedDb);
  try {
    // Support both full ID and prefix match
    let targetId = id;
    const exact = db.prepare('SELECT id, type, title FROM entries WHERE id = ?').get(id) as { id: string; type: string; title: string } | undefined;
    let entry: { id: string; type: string; title: string };

    if (exact) {
      entry = exact;
    } else {
      const prefix = db.prepare('SELECT id, type, title FROM entries WHERE id LIKE ?').all(`${id}%`) as { id: string; type: string; title: string }[];
      if (prefix.length === 0) {
        return `Entry "${id}" not found.`;
      }
      if (prefix.length > 1) {
        return `Ambiguous ID prefix "${id}". Matches: ${prefix.map(p => `${p.id.slice(0, 8)} [${p.type}] ${p.title}`).join(', ')}`;
      }
      entry = prefix[0];
      targetId = entry.id;
    }

    if (!options.force) {
      // In non-interactive CLI, --force is required for safety
      return `Delete [${entry.type}] "${entry.title}" (${targetId.slice(0, 8)})? Use --force to confirm.`;
    }

    db.prepare('DELETE FROM entries WHERE id = ?').run(targetId);

    if (options.json) {
      return JSON.stringify({ deleted: true, id: targetId, type: entry.type, title: entry.title });
    }

    return `✓ Deleted [${entry.type}] "${entry.title}" (${targetId.slice(0, 8)})`;
  } finally {
    db.close();
  }
}
