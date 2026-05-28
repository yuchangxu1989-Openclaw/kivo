/**
 * Wiki Repository Singleton — shared across wiki API routes.
 * Lazily initializes the WikiRepository on first access.
 */

import { WikiRepository } from '@kivo/wiki/db/wiki-repository';
import { resolveKivoDbPath } from '@/lib/db';

let instance: WikiRepository | null = null;
let instancePath: string | null = null;

function resolveDbPath(): string {
  return resolveKivoDbPath();
}

export function getWikiRepository(): WikiRepository {
  const dbPath = resolveDbPath();
  if (!instance || instancePath !== dbPath) {
    if (instance && instancePath !== dbPath) {
      instance.close();
    }
    instance = new WikiRepository({ dbPath });
    instancePath = dbPath;
  }
  return instance;
}
