/**
 * Wiki Repository Singleton — shared across wiki API routes.
 * Lazily initializes the WikiRepository on first access.
 */

import { WikiRepository } from '@kivo/wiki/db/wiki-repository';
import path from 'path';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');

let instance: WikiRepository | null = null;

export function getWikiRepository(): WikiRepository {
  if (!instance) {
    instance = new WikiRepository({ dbPath: DB_PATH });
  }
  return instance;
}
