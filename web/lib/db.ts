import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const FALLBACK_DB_PATH = '/root/.openclaw/workspace/projects/kivo/kivo.db';

export function resolveKivoDbPath(): string {
  if (process.env.KIVO_DB_PATH?.trim()) {
    return process.env.KIVO_DB_PATH.trim();
  }

  const candidates = [
    path.resolve(process.cwd(), '../kivo.db'),
    path.resolve(process.cwd(), 'kivo.db'),
    FALLBACK_DB_PATH,
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

export function getWebDbPath(): string {
  return resolveKivoDbPath();
}

export function openWebDb(readonly = false): Database.Database {
  const db = new Database(getWebDbPath(), { readonly });
  db.pragma('foreign_keys = ON');
  return db;
}
