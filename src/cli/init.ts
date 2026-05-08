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

  // FR-Z02 / FR-B04: Detect Ollama + bge-m3 and auto-configure embedding backend
  const ollamaStatus = await detectOllama();
  if (ollamaStatus.available && ollamaStatus.hasBgeM3) {
    lines.push('✓ 检测到本地 Ollama bge-m3，已自动配置向量化后端');
    // FR-Z02: Auto-run embed-backfill if seed data was just created
    if (seeded > 0) {
      lines.push('');
      lines.push('正在对种子知识生成向量索引...');
      try {
        const { runEmbedBackfill } = await import('./embed-backfill.js');
        const backfillResult = await runEmbedBackfill({ batchSize: 20, sleepMs: 500 });
        if (backfillResult.includes('✓')) {
          lines.push('✓ 向量化完成，语义搜索已就绪');
        } else {
          lines.push(`⚠ 向量化未完成：${backfillResult}`);
          lines.push('  可稍后手动执行：npx kivo embed-backfill');
        }
      } catch (err) {
        lines.push(`⚠ 向量化跳过：${(err as Error).message}`);
        lines.push('  可稍后手动执行：npx kivo embed-backfill');
      }
    }
  } else if (ollamaStatus.available && !ollamaStatus.hasBgeM3) {
    lines.push('⚠ 检测到 Ollama 但未找到 bge-m3 模型');
    lines.push('  拉取命令：ollama pull bge-m3:latest');
    lines.push('  拉取后重新运行 npx kivo init 即可启用语义搜索');
  } else {
    lines.push('⚠ 未检测到向量化后端，当前使用关键词搜索');
    lines.push('  启用语义搜索（可选）：');
    lines.push('    方式一：安装 Ollama + bge-m3（推荐，本地免费）');
    lines.push('      curl -fsSL https://ollama.com/install.sh | sh');
    lines.push('      ollama pull bge-m3:latest');
    lines.push('      npx kivo init  # 重新初始化以检测 Ollama');
    lines.push('    方式二：npx kivo init --interactive 选择 openai 并填写 API Key');
  }

  // FR-Z06: Demo search to prove system works after seeding
  if (seeded > 0) {
    lines.push('');
    lines.push('── 首次知识旅程 ──');
    try {
      const demoDb = new Database(resolvedDb, { readonly: true });
      const demoRows = demoDb.prepare(
        `SELECT e.type, e.title FROM entries e
         JOIN entries_fts ON entries_fts.rowid = e.rowid
         WHERE entries_fts MATCH 'KIVO'
         ORDER BY rank LIMIT 3`
      ).all() as Array<{ type: string; title: string }>;
      demoDb.close();

      if (demoRows.length > 0) {
        lines.push(`  搜索 "KIVO" → 找到 ${demoRows.length} 条结果：`);
        for (const row of demoRows) {
          lines.push(`    [${row.type}] ${row.title}`);
        }
        lines.push('');
        lines.push('  系统可用！试试：npx kivo query "你的问题"');
      } else {
        lines.push('  试试：npx kivo query "知识管理"');
      }
    } catch {
      lines.push('  试试：npx kivo query "知识管理"');
    }
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('KIVO 已就绪。下一步：');
  lines.push('');
  lines.push('  npx kivo query <text>    搜索知识库');
  lines.push('  npx kivo search <text>   同上（别名）');
  lines.push('  npx kivo health          健康检查');
  lines.push('  npx kivo add <type> <title> --content "..."  添加知识');
  lines.push('');


  // Install intent injection hook into OpenClaw workspace
  const hookResult = installIntentInjectionHook();
  if (hookResult) {
    lines.push(hookResult);
  } else {
    lines.push('  启动 Web 工作台：');
    lines.push('    AUTH_PASSWORD=你的密码 npx kivo web');
    lines.push('    然后浏览器打开 http://localhost:3721');
    lines.push('');
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

function buildApiKeyGuidance(config: Record<string, unknown>): string[] {
  const embedding = config.embedding as { provider?: string; options?: { apiKey?: string } } | null | undefined;
  if (!embedding || embedding.provider !== 'openai') {
    return [
      'Embedding 配置：当前使用关键词检索。如需语义检索，请设置：',
      '  KIVO_EMBEDDING_PROVIDER=openai',
      '  KIVO_EMBEDDING_API_KEY=<your_api_key>',
      '  KIVO_EMBEDDING_MODEL=text-embedding-3-small',
    ];
  }

  if (!embedding.options?.apiKey) {
    return [
      'Embedding 配置：已选择 OpenAI，但还缺 API key。请设置：',
      '  export KIVO_EMBEDDING_API_KEY=<your_api_key>',
      '然后运行：npx kivo config-check',
    ];
  }

  return ['Embedding 配置：OpenAI API key 已配置，可运行 npx kivo config-check 验证有效性。'];
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

/**
 * Detect if Ollama is running locally and has bge-m3 model available.
 */
async function detectOllama(baseUrl = 'http://localhost:11434'): Promise<{ available: boolean; hasBgeM3: boolean }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return { available: false, hasBgeM3: false };

    const json = await res.json() as { models?: Array<{ name: string }> };
    if (!json.models || !Array.isArray(json.models)) {
      return { available: true, hasBgeM3: false };
    }

    const hasBgeM3 = json.models.some((m: { name: string }) =>
      m.name === 'bge-m3' ||
      m.name === 'bge-m3:latest' ||
      m.name.startsWith('bge-m3:')
    );

    return { available: true, hasBgeM3 };
  } catch {
    return { available: false, hasBgeM3: false };
  }
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
