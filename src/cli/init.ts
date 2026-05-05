import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { seedKnowledge } from '../seed/seed-knowledge.js';
import { buildAutomationCommands, installAutomationCrontab } from './automation-setup.js';

const CONFIG_FILENAME = 'kivo.config.json';
const MIN_NODE_MAJOR = 20;

export interface InitOptions {
  dir?: string;
  nonInteractive?: boolean;
  interactive?: boolean;
}

function checkNodeVersion(): string | null {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < MIN_NODE_MAJOR) {
    return `Node.js >= ${MIN_NODE_MAJOR} required (current: ${process.versions.node})`;
  }
  return null;
}

function initDatabase(dbPath: string): string {
  const resolvedPath = resolve(dbPath);
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');

  // Migrate: if entries_fts exists but uses old tokenizer (not trigram), drop and recreate
  const oldFts = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='entries_fts'"
  ).get() as { sql: string } | undefined;
  if (oldFts && !oldFts.sql.includes('trigram')) {
    db.exec(`
      DROP TRIGGER IF EXISTS entries_ai;
      DROP TRIGGER IF EXISTS entries_ad;
      DROP TRIGGER IF EXISTS entries_au;
      DROP TABLE IF EXISTS entries_fts;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS kivo_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL DEFAULT '{}',
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      tags_json TEXT NOT NULL DEFAULT '[]',
      domain TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      version INTEGER NOT NULL DEFAULT 1,
      supersedes TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      title, content, summary,
      content='entries',
      content_rowid='rowid',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
      INSERT INTO entries_fts(rowid, title, content, summary)
      VALUES (new.rowid, new.title, new.content, new.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, title, content, summary)
      VALUES ('delete', old.rowid, old.title, old.content, old.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, title, content, summary)
      VALUES ('delete', old.rowid, old.title, old.content, old.summary);
      INSERT INTO entries_fts(rowid, title, content, summary)
      VALUES (new.rowid, new.title, new.content, new.summary);
    END;
  `);

  // Rebuild FTS index after migration
  if (oldFts && !oldFts.sql.includes('trigram')) {
    db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`);
  }

  db.close();
  return resolvedPath;
}

export async function runInit(options: InitOptions = {}): Promise<string> {
  const lines: string[] = [];

  const nodeErr = checkNodeVersion();
  if (nodeErr) return nodeErr;
  lines.push(`✓ Node.js ${process.versions.node}`);

  const dir = resolve(options.dir ?? process.cwd());
  const configPath = join(dir, CONFIG_FILENAME);

  let config: Record<string, unknown>;

  if (existsSync(configPath)) {
    lines.push(`✓ Config already exists: ${configPath}`);
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    config = raw;
  } else {
    // Default: non-interactive (use defaults). Use --interactive for prompts.
    const useInteractive = options.interactive === true && options.nonInteractive !== true;
    if (useInteractive) {
      config = await interactiveInit();
    } else {
      config = buildDefaultConfig();
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    lines.push(`✓ Config written: ${configPath}`);
  }

  const dbPath = typeof config.dbPath === 'string' ? config.dbPath : String(DEFAULT_CONFIG.dbPath);
  const resolvedDb = initDatabase(resolve(dir, dbPath));
  lines.push(`✓ Database initialized: ${resolvedDb}`);

  const seeded = seedKnowledge(resolvedDb);
  if (seeded > 0) {
    lines.push(`✓ 已创建 ${seeded} 条种子知识，打开知识库开始探索`);
    const db = new Database(resolvedDb);
    db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`);
    db.close();
  }

  lines.push('');
  lines.push('KIVO 已就绪。');
  lines.push('  npx kivo health       — 健康检查');
  lines.push('  npx kivo query <text> — 搜索知识库');
  lines.push('');

  // Install intent injection hook into OpenClaw workspace
  const hookResult = installIntentInjectionHook();
  if (hookResult) {
    lines.push(hookResult);
  }

  const automation = buildAutomationCommands(dir);
  lines.push('自动化建议：');
  lines.push(`  cron 定时治理：${automation.cronLines[0]}`);
  lines.push(`  badcase 监听：${automation.cronLines[1]}`);
  lines.push(`  手动前台运行：npx ${automation.watcherCommand} --once`);

  const crontabResult = installAutomationCrontab(dir);
  lines.push(`  自动注册：${crontabResult.message}`);

  return lines.join('\n');
}

function installIntentInjectionHook(): string | null {
  // Resolve OpenClaw workspace
  const workspacePath = process.env.OPENCLAW_WORKSPACE
    || join(process.env.HOME || process.env.USERPROFILE || '', '.openclaw', 'workspace');

  if (!existsSync(workspacePath)) return null;

  const hooksDir = join(workspacePath, 'hooks', 'kivo-intent-injection');

  // Resolve source hook files from the KIVO package
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // In dist: dist/esm/cli/init.js -> package root is 3 levels up
  // In src: src/cli/init.ts -> package root is 2 levels up
  let pkgRoot = resolve(__dirname, '..', '..', '..');
  let srcHookDir = join(pkgRoot, 'hooks', 'kivo-intent-injection');
  if (!existsSync(join(srcHookDir, 'handler.js'))) {
    // Try 2 levels up (src layout)
    pkgRoot = resolve(__dirname, '..', '..');
    srcHookDir = join(pkgRoot, 'hooks', 'kivo-intent-injection');
  }

  const srcHandler = join(srcHookDir, 'handler.js');
  const srcHookMd = join(srcHookDir, 'HOOK.md');

  if (!existsSync(srcHandler)) return null;

  // Create target directory and copy files
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  copyFileSync(srcHandler, join(hooksDir, 'handler.js'));
  if (existsSync(srcHookMd)) {
    copyFileSync(srcHookMd, join(hooksDir, 'HOOK.md'));
  }

  return '✓ KIVO 意图注入 hook 已安装到 ' + hooksDir + '，请重启 Gateway 使其生效';
}

function buildDefaultConfig(): Record<string, unknown> {
  return {
    dbPath: DEFAULT_CONFIG.dbPath,
    mode: DEFAULT_CONFIG.mode,
    conflictThreshold: DEFAULT_CONFIG.conflictThreshold,
    embedding: null,
  };
}

async function interactiveInit(): Promise<Record<string, unknown>> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, fallback: string): Promise<string> =>
    new Promise(res => rl.question(`${q} [${fallback}]: `, ans => res(ans.trim() || fallback)));

  try {
    const dbPath = await ask('Database path', String(DEFAULT_CONFIG.dbPath));
    const mode = await ask('Mode (standalone/hosted)', String(DEFAULT_CONFIG.mode));
    const threshold = await ask('Conflict threshold (0-1)', String(DEFAULT_CONFIG.conflictThreshold));
    const embeddingChoice = await ask('Embedding provider (none/openai/local)', 'none');

    const config: Record<string, unknown> = {
      dbPath,
      mode,
      conflictThreshold: parseFloat(threshold),
    };

    if (embeddingChoice !== 'none') {
      const embeddingConfig: Record<string, unknown> = { provider: embeddingChoice };
      if (embeddingChoice === 'openai') {
        const apiKey = await ask('OpenAI API key', '');
        if (apiKey) {
          embeddingConfig.options = { apiKey };
        }
      }
      config.embedding = embeddingConfig;
    } else {
      config.embedding = null;
    }

    return config;
  } finally {
    rl.close();
  }
}

export function generateExampleConfig(): string {
  return JSON.stringify(
    {
      $schema: 'https://kivo.dev/config-schema.json',
      dbPath: './kivo.db',
      mode: 'standalone',
      conflictThreshold: 0.80,
      embedding: {
        provider: 'openai',
        options: {
          apiKey: '${KIVO_EMBEDDING_API_KEY}',
          model: 'text-embedding-3-small',
          dimensions: 1536,
          cacheSize: 1000,
        },
      },
      _comments: {
        dbPath: 'SQLite database path. Use ":memory:" for in-memory mode.',
        mode: '"standalone" for single-machine, "hosted" for embedded in host app.',
        conflictThreshold: 'Similarity threshold for conflict detection (0-1).',
        embedding: 'Set to null to use keyword-only search.',
      },
    },
    null,
    2
  );
}
