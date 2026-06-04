import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { buildAutomationCommands, installAutomationCrontab, isOpenClawHost } from './automation-setup.js';

const CONFIG_FILENAME = 'kivo.config.json';
const MIN_NODE_MAJOR = 20;

/**
 * Ask a yes/no confirmation question. Returns true for Y/y/empty (default yes).
 */
function askConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}

export interface InitOptions {
  dir?: string;
  nonInteractive?: boolean;
  interactive?: boolean;
  autoSetup?: boolean;
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
      supersedes TEXT,
      embedding BLOB
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

  const entryColumns = (db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>).map(c => c.name);
  if (!entryColumns.includes('embedding')) {
    db.exec('ALTER TABLE entries ADD COLUMN embedding BLOB');
  }
  // P0-4: 价值衰减治理依赖最近命中时间戳（ISO 字符串，默认 NULL）
  if (!entryColumns.includes('last_hit_at')) {
    db.exec('ALTER TABLE entries ADD COLUMN last_hit_at TEXT');
  }

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

  // FR: Embedding provider detection and guidance (mandatory for vector search)
  const embeddingStatus = await detectAndConfigureEmbedding(dir, config, configPath, options);
  lines.push(...embeddingStatus.lines);

  const seeded = await seedKnowledgeWithEmbeddings(resolvedDb, dir, embeddingStatus.available);
  if (seeded.inserted > 0) {
    lines.push(`✓ 已创建 ${seeded.inserted} 条种子知识，打开知识库开始探索`);
    if (seeded.embedded > 0) {
      lines.push(`✓ 已为 ${seeded.embedded} 条种子知识生成向量索引，语义搜索已就绪`);
    } else if (embeddingStatus.available) {
      lines.push('⚠ 种子知识向量化未完成，可稍后手动执行：npx kivo embed-backfill');
    }
  }

  lines.push('');
  lines.push('KIVO 已就绪。');
  lines.push('  npx kivo health       — 健康检查');
  lines.push('  npx kivo query <text> — 搜索知识库');
  lines.push('');

  if (isOpenClawHost()) {
    lines.push(...installIntentInjectionHook());
    lines.push('⚠️  请重启 OpenClaw Gateway 以加载知识注入 Hook：');
    lines.push('   openclaw gateway restart');
    lines.push('');
  } else {
    lines.push('ℹ 未检测到 OpenClaw 宿主环境，已跳过 Hook 安装和 Gateway 重启提示。');
    lines.push('');
  }

  const automation = buildAutomationCommands(dir);
  lines.push('自动化建议：');
  lines.push(`  cron 定时治理：${automation.cronLines[0]}`);
  lines.push(`  badcase 监听：${automation.cronLines[1]}`);
  lines.push(`  手动前台运行：npx ${automation.watcherCommand} --once`);

  if (isOpenClawHost()) {
    const crontabResult = installAutomationCrontab(dir);
    lines.push(`  自动注册：${crontabResult.message}`);
  } else {
    lines.push('  自动注册：未检测到 OpenClaw 宿主环境，跳过 crontab 写入。');
  }

  return lines.join('\n');
}

/**
 * Detect and configure embedding provider.
 * Returns status lines and whether embedding is available.
 */
async function detectAndConfigureEmbedding(
  dir: string,
  config: Record<string, unknown>,
  configPath: string,
  options: InitOptions,
): Promise<{ lines: string[]; available: boolean }> {
  const lines: string[] = [];

  const embeddingConfig = config.embedding as { provider?: string } | null | undefined;
  const hasEmbeddingConfig = embeddingConfig && embeddingConfig.provider && embeddingConfig.provider !== 'none';

  if (hasEmbeddingConfig) {
    try {
      const { checkEmbeddingHealth } = await import('../embedding/health-check.js');
      const result = await checkEmbeddingHealth(dir);
      lines.push(`\u2713 Embedding provider \u5df2\u914d\u7f6e\u4e14\u53ef\u7528 (${result.provider}/${result.model}, ${result.dimensions}d)`);
      return { lines, available: true };
    } catch (err) {
      lines.push(`\u2717 Embedding provider \u914d\u7f6e\u5f02\u5e38\uff1a${(err as Error).message}`);
      lines.push('');
      return { lines, available: false };
    }
  }

  const ollamaStatus = await detectOllama();

  if (ollamaStatus.available && ollamaStatus.hasBgeM3) {
    config.embedding = { provider: 'ollama', model: 'bge-m3:latest', baseUrl: 'http://localhost:11434' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    lines.push('\u2713 \u68c0\u6d4b\u5230\u672c\u5730 Ollama bge-m3\uff0c\u5df2\u81ea\u52a8\u914d\u7f6e\u5411\u91cf\u68c0\u7d22\u540e\u7aef');
    return { lines, available: true };
  }

  if (ollamaStatus.available && !ollamaStatus.hasBgeM3) {
    if (options.autoSetup) {
      lines.push('\u2139 \u68c0\u6d4b\u5230 Ollama\uff0c\u6b63\u5728\u62c9\u53d6 bge-m3 \u6a21\u578b...');
      try {
        const { execSync } = await import('node:child_process');
        execSync('ollama pull bge-m3:latest', { timeout: 300000, stdio: 'pipe' });
        config.embedding = { provider: 'ollama', model: 'bge-m3:latest', baseUrl: 'http://localhost:11434' };
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        lines.push('\u2713 bge-m3 \u62c9\u53d6\u5b8c\u6210\uff0c\u5df2\u81ea\u52a8\u914d\u7f6e\u5411\u91cf\u68c0\u7d22\u540e\u7aef');
        return { lines, available: true };
      } catch (err) {
        lines.push(`\u2717 bge-m3 \u62c9\u53d6\u5931\u8d25\uff1a${(err as Error).message}`);
        lines.push('  \u8bf7\u624b\u52a8\u6267\u884c\uff1aollama pull bge-m3:latest');
        return { lines, available: false };
      }
    }
    lines.push('\u26a0 \u68c0\u6d4b\u5230 Ollama \u4f46\u672a\u627e\u5230 bge-m3 \u6a21\u578b');
    lines.push('  \u62c9\u53d6\u547d\u4ee4\uff1aollama pull bge-m3:latest');
    lines.push('  \u6216\u4f7f\u7528\uff1anpx kivo init --auto-setup \u81ea\u52a8\u62c9\u53d6');
    lines.push('  \u62c9\u53d6\u540e\u91cd\u65b0\u8fd0\u884c npx kivo init \u5373\u53ef\u542f\u7528\u8bed\u4e49\u641c\u7d22');
    return { lines, available: false };
  }

  if (options.autoSetup) {
    lines.push('\u2139 \u672a\u68c0\u6d4b\u5230 Ollama\uff0c\u6b63\u5728\u81ea\u52a8\u5b89\u88c5...');
    try {
      const installed = await installOllama(options);
      if (installed) {
        lines.push('\u2713 Ollama \u5b89\u88c5\u5b8c\u6210');
        // Start ollama serve in background
        lines.push('\u2139 \u6b63\u5728\u542f\u52a8 Ollama \u670d\u52a1...');
        try {
          const { execSync, spawn } = await import('node:child_process');
          // Try to start ollama serve in background
          const child = spawn('ollama', ['serve'], {
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
          // Wait a moment for it to start
          await new Promise(r => setTimeout(r, 2000));
          lines.push('\u2713 Ollama \u670d\u52a1\u5df2\u542f\u52a8');
        } catch {
          lines.push('\u26a0 Ollama \u670d\u52a1\u542f\u52a8\u5931\u8d25\uff0c\u8bf7\u624b\u52a8\u6267\u884c\uff1aollama serve');
        }
        // Now pull bge-m3
        lines.push('\u2139 \u6b63\u5728\u62c9\u53d6 bge-m3 \u6a21\u578b\uff08\u7ea6 1.5GB\uff0c\u8bf7\u7a0d\u5019\uff09...');
        try {
          const { execSync } = await import('node:child_process');
          execSync('ollama pull bge-m3:latest', { timeout: 600000, stdio: 'pipe' });
          config.embedding = { provider: 'ollama', model: 'bge-m3:latest', baseUrl: 'http://localhost:11434' };
          writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
          lines.push('\u2713 bge-m3 \u62c9\u53d6\u5b8c\u6210\uff0c\u5df2\u81ea\u52a8\u914d\u7f6e\u5411\u91cf\u68c0\u7d22\u540e\u7aef');
          return { lines, available: true };
        } catch (pullErr) {
          lines.push(`\u2717 bge-m3 \u62c9\u53d6\u5931\u8d25\uff1a${(pullErr as Error).message}`);
          lines.push('  \u8bf7\u624b\u52a8\u6267\u884c\uff1aollama pull bge-m3:latest');
          return { lines, available: false };
        }
      } else {
        lines.push('\u2717 Ollama \u5b89\u88c5\u5931\u8d25');
        lines.push('  \u8bf7\u624b\u52a8\u5b89\u88c5\uff1ahttps://ollama.com/download');
        return { lines, available: false };
      }
    } catch (installErr) {
      lines.push(`\u2717 Ollama \u5b89\u88c5\u5931\u8d25\uff1a${(installErr as Error).message}`);
      lines.push('  \u8bf7\u624b\u52a8\u5b89\u88c5\uff1ahttps://ollama.com/download');
      lines.push('  Linux/macOS: curl -fsSL https://ollama.com/install.sh | sh');
      return { lines, available: false };
    }
  }

  // Ollama not detected - offer interactive installation
  if (!options.nonInteractive && process.stdin.isTTY) {
    const shouldInstall = await askConfirm('检测到 Ollama 未安装，是否自动安装？(Y/n)');
    if (shouldInstall) {
      lines.push('\u2139 \u6b63\u5728\u5b89\u88c5 Ollama...');
      const installed = await installOllama(options);
      if (installed) {
        lines.push('\u2713 Ollama \u5b89\u88c5\u5b8c\u6210');
        // Start ollama serve in background
        try {
          const { spawn } = await import('node:child_process');
          const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
          child.unref();
          await new Promise(r => setTimeout(r, 2000));
          lines.push('\u2713 Ollama \u670d\u52a1\u5df2\u542f\u52a8');
        } catch {
          lines.push('\u26a0 Ollama \u670d\u52a1\u542f\u52a8\u5931\u8d25\uff0c\u8bf7\u624b\u52a8\u6267\u884c\uff1aollama serve');
        }
        // Pull bge-m3
        lines.push('\u2139 \u6b63\u5728\u62c9\u53d6 bge-m3 \u6a21\u578b\uff08\u7ea6 1.5GB\uff0c\u8bf7\u7a0d\u5019\uff09...');
        try {
          const { execSync } = await import('node:child_process');
          execSync('ollama pull bge-m3:latest', { timeout: 600000, stdio: 'pipe' });
          config.embedding = { provider: 'ollama', model: 'bge-m3:latest', baseUrl: 'http://localhost:11434' };
          writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
          lines.push('\u2713 bge-m3 \u62c9\u53d6\u5b8c\u6210\uff0c\u5df2\u81ea\u52a8\u914d\u7f6e\u5411\u91cf\u68c0\u7d22\u540e\u7aef');
          return { lines, available: true };
        } catch (pullErr) {
          lines.push(`\u2717 bge-m3 \u62c9\u53d6\u5931\u8d25\uff1a${(pullErr as Error).message}`);
          lines.push('  \u8bf7\u624b\u52a8\u6267\u884c\uff1aollama pull bge-m3:latest');
          return { lines, available: false };
        }
      } else {
        lines.push('\u2717 Ollama \u5b89\u88c5\u5931\u8d25\uff0c\u8bf7\u624b\u52a8\u5b89\u88c5\uff1ahttps://ollama.com/download');
      }
    }
  }

  lines.push('\u2717 \u672a\u68c0\u6d4b\u5230 embedding provider\u3002KIVO \u9700\u8981\u5411\u91cf\u68c0\u7d22\u6a21\u578b\u624d\u80fd\u5de5\u4f5c\u3002');
  lines.push('');
  lines.push('  \u63a8\u8350\u65b9\u6848\uff08\u672c\u5730\u514d\u8d39\uff09\uff1a');
  lines.push('    curl -fsSL https://ollama.com/install.sh | sh');
  lines.push('    ollama serve');
  lines.push('    ollama pull bge-m3:latest');
  lines.push('    npx kivo init  # \u91cd\u65b0\u521d\u59cb\u5316\u4ee5\u68c0\u6d4b Ollama');
  lines.push('');
  lines.push('  \u5176\u4ed6\u65b9\u6848\uff1a');
  lines.push('    npx kivo init --interactive  # \u9009\u62e9 openai-compatible \u5e76\u586b\u5199 API Key');
  lines.push('    \u6216\u624b\u52a8\u7f16\u8f91 kivo.config.json \u8bbe\u7f6e embedding.provider / embedding.model / embedding.baseUrl');
  return { lines, available: false };
}

/**
 * Detect if Ollama is running locally and has bge-m3 model available.
 */
async function detectOllama(baseUrl = 'http://localhost:11434'): Promise<{ available: boolean; hasBgeM3: boolean }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { available: false, hasBgeM3: false };
    const json = await res.json() as { models?: Array<{ name: string }> };
    if (!json.models || !Array.isArray(json.models)) return { available: true, hasBgeM3: false };
    const hasBgeM3 = json.models.some((m: { name: string }) =>
      m.name === 'bge-m3' || m.name === 'bge-m3:latest' || m.name.startsWith('bge-m3:')
    );
    return { available: true, hasBgeM3 };
  } catch {
    return { available: false, hasBgeM3: false };
  }
}

/**
 * Install Ollama automatically.
 * Supports Linux and macOS via the official install script.
 * Returns true if installation succeeded.
 */
async function installOllama(options: InitOptions): Promise<boolean> {
  const { execSync } = await import('node:child_process');
  const platform = process.platform;

  if (platform === 'win32') {
    // Windows: cannot auto-install via shell script
    return false;
  }

  // Linux and macOS: use official install script
  try {
    execSync('curl -fsSL https://ollama.com/install.sh | sh', {
      timeout: 300000, // 5 min timeout
      stdio: 'pipe',
      shell: '/bin/sh',
    });
    // Verify installation
    execSync('ollama --version', { timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function installIntentInjectionHook(): string[] {
  const workspacePath = process.env.OPENCLAW_WORKSPACE
    || join(process.env.HOME || process.env.USERPROFILE || '', '.openclaw', 'workspace');
  const hookDir = join(workspacePath, 'hooks', 'kivo-intent-injection');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const candidateAssetDirs = [
    // dist/esm/cli/init.js -> dist/esm/assets/hook (after tsc copies JS only this is absent)
    join(__dirname, '..', 'assets', 'hook'),
    // dist/esm/cli/init.js -> package root assets/hook
    join(__dirname, '..', '..', '..', 'assets', 'hook'),
    // src/cli/init.ts -> package root assets/hook
    join(__dirname, '..', '..', 'assets', 'hook'),
  ];
  const assetHookDir = candidateAssetDirs.find(dir => existsSync(join(dir, 'handler.js')) && existsSync(join(dir, 'config.json')));

  if (!assetHookDir) {
    return ['⚠️  知识注入 Hook 资源缺失，跳过安装'];
  }

  if (!existsSync(hookDir)) {
    mkdirSync(hookDir, { recursive: true });
    copyFileSync(join(assetHookDir, 'handler.js'), join(hookDir, 'handler.js'));
    copyFileSync(join(assetHookDir, 'config.json'), join(hookDir, 'config.json'));
    return [`✅ 知识注入 Hook 已安装到 ${hookDir}`];
  }

  return ['ℹ️  知识注入 Hook 已存在，跳过安装'];
}

interface SeedEntryForEmbedding {
  title: string;
  content: string;
  domain: string;
  type: 'fact' | 'methodology';
}

const SEED_ENTRIES: SeedEntryForEmbedding[] = [
  { title: 'KIVO使用指南', content: 'KIVO 是 Agent 知识平台。通过对话自动提取知识，用向量语义搜索在对话时注入相关上下文。支持 kivo extract 手动提取、kivo search 搜索、kivo health 检查状态。', domain: 'system', type: 'fact' },
  { title: '知识提取触发方式', content: '知识提取有三种方式：1) 对话时实时提取（hook 自动触发）；2) 定时批量提取（cron 每2小时扫描历史会话）；3) 手动提取（kivo extract-sessions）。提取后的知识自动向量化存入 DB。', domain: 'system', type: 'methodology' },
  { title: '向量搜索工作原理', content: '用户发消息时，hook 用 Ollama bge-m3 生成消息的 1024 维向量，然后与 DB 中所有知识条目的向量做余弦相似度计算，返回 top 10 相关条目（阈值 0.3）注入到 agent 上下文中。', domain: 'system', type: 'fact' }
];

async function seedKnowledgeWithEmbeddings(dbPath: string, dir: string, embeddingAvailable: boolean): Promise<{ inserted: number; embedded: number }> {
  const db = new Database(dbPath);
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM entries').get() as { cnt: number };
  if (existing.cnt > 0) {
    db.close();
    return { inserted: 0, embedded: 0 };
  }

  const now = new Date().toISOString();
  const ids: string[] = [];
  const insert = db.prepare(`
    INSERT INTO entries (id, type, title, content, summary, source_json, confidence, status, tags_json, domain, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction(() => {
    for (const entry of SEED_ENTRIES) {
      const id = randomUUID();
      ids.push(id);
      const source = JSON.stringify({ type: 'system', reference: 'kivo:init-seed', timestamp: now });
      insert.run(id, entry.type, entry.title, entry.content, entry.content.slice(0, 80), source, 0.9, 'active', JSON.stringify(['kivo', 'seed']), entry.domain, 1, now, now);
    }
  });
  insertMany();

  let embedded = 0;
  if (embeddingAvailable) {
    try {
      const { createEmbeddingProvider } = await import('../embedding/create-provider.js');
      const { readEmbeddingConfig } = await import('../embedding/health-check.js');
      const embedder = createEmbeddingProvider(readEmbeddingConfig(dir));
      const update = db.prepare('UPDATE entries SET embedding = ? WHERE id = ?');
      for (let i = 0; i < SEED_ENTRIES.length; i++) {
        const entry = SEED_ENTRIES[i];
        const embedding = await embedder.embed(`${entry.title}\n${entry.content}`);
        update.run(Buffer.from(new Float32Array(embedding).buffer), ids[i]);
        embedded++;
      }
      if ('close' in embedder && typeof embedder.close === 'function') {
        await embedder.close();
      }
    } catch {
      embedded = 0;
    }
  }

  db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`);
  db.close();
  return { inserted: SEED_ENTRIES.length, embedded };
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
