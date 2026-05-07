import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadEnvConfig } from '../config/env-loader.js';
import { validateConfigDetailed, formatValidationErrors } from '../config/config-validator.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import type { KivoConfig } from '../config/types.js';

/**
 * Resolve a require function that works in both CJS and ESM contexts.
 * In CJS, global `require` is available directly.
 * In ESM, we create one via `createRequire` anchored to cwd so it can
 * find the consumer's node_modules (e.g. better-sqlite3).
 *
 * Note: `eval('import.meta.url')` does NOT work in Node ESM — import.meta
 * is only available in static module code, not in eval/Function contexts.
 * Using pathToFileURL(cwd) avoids this entirely.
 */
function getRequire(): NodeRequire {
  if (typeof require !== 'undefined') return require;
  return createRequire(pathToFileURL(join(process.cwd(), '__kivo_resolve__.js')).href);
}
const esmRequire = getRequire();

/**
 * A require anchored to the package's own directory so we can resolve
 * dependencies (like better-sqlite3) even when cwd is elsewhere.
 * Uses Error.stack to determine the current file's location at runtime.
 */
function getPkgRequire(): NodeRequire {
  if (typeof require !== 'undefined') {
    // CJS: __dirname is available, resolve from there
    return createRequire(pathToFileURL(join(__dirname, '__kivo_resolve__.js')).href);
  }
  // ESM: walk up from this file to find package.json
  const origPrepare = Error.prepareStackTrace;
  Error.prepareStackTrace = (_err, stack) => stack;
  const err = new Error();
  const stack = err.stack as unknown as NodeJS.CallSite[];
  Error.prepareStackTrace = origPrepare;
  if (stack && stack.length > 0) {
    for (const frame of stack) {
      const filename = frame.getFileName();
      if (filename && (filename.startsWith('/') || filename.startsWith('file:'))) {
        // Resolve the file path and walk up to find package.json
        let dir = filename.startsWith('file:') 
          ? resolve(new URL(filename).pathname, '..') 
          : resolve(filename, '..');
        for (let i = 0; i < 10; i++) {
          if (existsSync(join(dir, 'package.json'))) {
            return createRequire(pathToFileURL(join(dir, '__kivo_resolve__.js')).href);
          }
          const parent = resolve(dir, '..');
          if (parent === dir) break;
          dir = parent;
        }
      }
    }
  }
  return esmRequire; // fallback
}

export interface HealthCheckItem {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  suggestion?: string;
}

export interface HealthReport {
  items: HealthCheckItem[];
  overall: 'healthy' | 'degraded' | 'unhealthy';
}

export async function runHealthCheck(configPath?: string): Promise<HealthReport> {
  const items: HealthCheckItem[] = [];

  items.push(checkNodeVersion());
  items.push(checkDiskSpace());
  items.push(await checkSqliteDependency());
  items.push(...checkConfig(configPath));
  items.push(checkEmbeddingProvider());
  items.push(await checkKnowledgeEntries());

  const hasFail = items.some(i => i.status === 'fail');
  const hasWarn = items.some(i => i.status === 'warn');
  const overall = hasFail ? 'unhealthy' : hasWarn ? 'degraded' : 'healthy';

  return { items, overall };
}

export function formatHealthReport(report: HealthReport): string {
  const lines: string[] = ['KIVO Health Check', '='.repeat(40), ''];

  for (const item of report.items) {
    const icon = item.status === 'ok' ? '[OK]' : item.status === 'warn' ? '[WARN]' : '[FAIL]';
    lines.push(`${icon} ${item.name}: ${item.detail}`);
    if (item.suggestion) {
      lines.push(`     -> ${item.suggestion}`);
    }
  }

  lines.push('');
  lines.push(`Overall: ${report.overall.toUpperCase()}`);
  return lines.join('\n');
}

function checkNodeVersion(): HealthCheckItem {
  const current = process.versions.node;
  const major = parseInt(current.split('.')[0], 10);
  if (major >= 20) {
    return { name: 'Node.js', status: 'ok', detail: `v${current}` };
  }
  return {
    name: 'Node.js',
    status: 'fail',
    detail: `v${current} (requires >= 20)`,
    suggestion: 'Install Node.js 20+ from https://nodejs.org',
  };
}

function checkDiskSpace(): HealthCheckItem {
  try {
    const stats = statfsSync(process.cwd());
    const freeGB = (stats.bfree * stats.bsize) / (1024 ** 3);
    if (freeGB >= 1) {
      return { name: 'Disk Space', status: 'ok', detail: `${freeGB.toFixed(1)} GB free` };
    }
    return {
      name: 'Disk Space',
      status: 'warn',
      detail: `${freeGB.toFixed(1)} GB free (< 1 GB)`,
      suggestion: 'Free up disk space. KIVO SQLite database may grow over time.',
    };
  } catch {
    return { name: 'Disk Space', status: 'warn', detail: 'Unable to check', suggestion: 'Ensure sufficient disk space is available.' };
  }
}

async function checkSqliteDependency(): Promise<HealthCheckItem> {
  // Resolve DB path from config (same logic as checkKnowledgeEntries)
  const dir = process.cwd();
  const cfgPath = join(dir, 'kivo.config.json');
  let dbPath = String(DEFAULT_CONFIG.dbPath);
  if (existsSync(cfgPath)) {
    try {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
    } catch {
      // ignore parse errors, use default
    }
  }
  const resolvedDb = resolve(dir, dbPath);

  // If DB file doesn't exist, it's not initialized yet
  if (!existsSync(resolvedDb)) {
    return {
      name: 'SQLite',
      status: 'warn',
      detail: 'Database file not found',
      suggestion: 'Run "kivo init" to create the database.',
    };
  }

  // Try multiple require anchors: cwd first, then package root
  const requireFns = [esmRequire];
  try { requireFns.push(getPkgRequire()); } catch { /* ignore */ }

  // Try to open DB and execute a simple query via better-sqlite3
  for (const req of requireFns) {
    try {
      const BetterSqlite3 = req('better-sqlite3');
      const db = new BetterSqlite3(resolvedDb, { readonly: true });
      db.prepare('SELECT 1').get();
      db.close();
      return { name: 'SQLite', status: 'ok', detail: `Database accessible (better-sqlite3)` };
    } catch {
      // not available from this anchor, try next
    }
  }

  // Try sql.js
  for (const req of requireFns) {
    try {
      const initSqlJs = req('sql.js');
      const SQL = await initSqlJs();
      const buf = readFileSync(resolvedDb);
      const db = new SQL.Database(buf);
      db.exec('SELECT 1');
      db.close();
      return { name: 'SQLite', status: 'ok', detail: `Database accessible (sql.js)` };
    } catch {
      // not available from this anchor, try next
    }
  }

  return {
    name: 'SQLite',
    status: 'fail',
    detail: 'Database exists but cannot be opened',
    suggestion: 'Ensure better-sqlite3 or sql.js is installed: npm install better-sqlite3',
  };
}

function checkConfig(configPath?: string): HealthCheckItem[] {
  const items: HealthCheckItem[] = [];
  const envConfig = loadEnvConfig();
  const merged = { ...DEFAULT_CONFIG, ...envConfig } as Partial<KivoConfig>;

  if (configPath && !existsSync(configPath)) {
    items.push({
      name: 'Config File',
      status: 'warn',
      detail: `${configPath} not found`,
      suggestion: 'Run "npx kivo init" to generate a config file.',
    });
  } else if (configPath) {
    items.push({ name: 'Config File', status: 'ok', detail: configPath });
  }

  const validation = validateConfigDetailed(merged);
  if (validation.valid) {
    items.push({ name: 'Config Validation', status: 'ok', detail: 'All fields valid' });
  } else {
    for (const err of validation.errors) {
      items.push({
        name: `Config: ${err.field}`,
        status: 'fail',
        detail: err.message,
        suggestion: err.suggestion,
      });
    }
  }

  return items;
}

function checkEmbeddingProvider(): HealthCheckItem {
  const provider = process.env.KIVO_EMBEDDING_PROVIDER;
  if (!provider) {
    return {
      name: 'Embedding Provider',
      status: 'warn',
      detail: 'Not configured (keyword search only)',
      suggestion: 'Set KIVO_EMBEDDING_PROVIDER=openai or =local for semantic search.',
    };
  }
  if (provider === 'openai' && !process.env.KIVO_EMBEDDING_API_KEY) {
    return {
      name: 'Embedding Provider',
      status: 'fail',
      detail: 'OpenAI selected but KIVO_EMBEDDING_API_KEY not set',
      suggestion: 'Set KIVO_EMBEDDING_API_KEY environment variable.',
    };
  }
  return { name: 'Embedding Provider', status: 'ok', detail: provider };
}

async function checkKnowledgeEntries(): Promise<HealthCheckItem> {
  try {
    const dir = process.cwd();
    const configPath = join(dir, 'kivo.config.json');
    let dbPath = String(DEFAULT_CONFIG.dbPath);
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
    }
    const resolvedDb = resolve(dir, dbPath);
    if (!existsSync(resolvedDb)) {
      return { name: 'Knowledge Base', status: 'warn', detail: 'Database not found', suggestion: 'Run "kivo init" to create the database.' };
    }
    let cnt: number;
    try {
      const BetterSqlite3 = esmRequire('better-sqlite3');
      const db = new BetterSqlite3(resolvedDb, { readonly: true });
      const row = db.prepare('SELECT COUNT(*) as cnt FROM entries').get() as { cnt: number };
      db.close();
      cnt = row.cnt;
    } catch {
      const initSqlJs = esmRequire('sql.js');
      const SQL = await initSqlJs();
      const buf = readFileSync(resolvedDb);
      const db = new SQL.Database(buf);
      const [result] = db.exec('SELECT COUNT(*) as cnt FROM entries');
      db.close();
      cnt = result?.values?.[0]?.[0] as number ?? 0;
    }
    if (cnt === 0) {
      return { name: 'Knowledge Base', status: 'warn', detail: '0 entries', suggestion: 'Run "kivo init" to load seed knowledge.' };
    }
    return { name: 'Knowledge Base', status: 'ok', detail: `${cnt} entries` };
  } catch {
    return { name: 'Knowledge Base', status: 'warn', detail: 'Unable to check', suggestion: 'Run "kivo init" first.' };
  }
}
