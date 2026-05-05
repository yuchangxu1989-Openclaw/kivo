/**
 * BootstrapRunner — 首次运行初始化流程
 *
 * FR-Z02:
 * - AC2: 管理员账号创建、存储路径确认、LLM Provider 配置校验
 * - AC3: 支持导入示例数据（可跳过）
 * - AC4: 初始化完成后引导跑通"导入→检索"演示路径
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { KivoError } from '../errors/kivo-error.js';
import { detectInitStatus, type InitStatus } from './init-detector.js';
import type { KivoConfig } from '../config/types.js';
import { validateConfigDetailed } from '../config/config-validator.js';

export interface BootstrapStepResult {
  step: string;
  success: boolean;
  message: string;
}

export interface BootstrapResult {
  completed: boolean;
  steps: BootstrapStepResult[];
  demoResult?: DemoResult;
}

export interface DemoResult {
  ingested: boolean;
  searchHit: boolean;
  entryId?: string;
  searchQuery?: string;
}

// ── 示例种子数据 ──

const SEED_ENTRIES = [
  {
    id: 'seed-fact-001',
    type: 'fact' as const,
    title: 'KIVO 知识类型体系',
    content: 'KIVO 支持六种知识类型：事实(fact)、方法论(methodology)、决策(decision)、经验(experience)、意图(intent)、元知识(meta)。',
    summary: 'KIVO 六种知识类型定义',
    tags: ['kivo', 'knowledge-type', 'seed'],
  },
  {
    id: 'seed-methodology-001',
    type: 'methodology' as const,
    title: '知识冲突解决流程',
    content: '当新知识与已有知识冲突时，KIVO 自动检测并标记冲突，支持保留新版、保留旧版、合并三种解决策略。',
    summary: '冲突检测与解决的标准流程',
    tags: ['kivo', 'conflict', 'seed'],
  },
];

// ── BootstrapRunner class ──

export class BootstrapRunner {
  private db: Database.Database | null = null;

  constructor(private readonly config: KivoConfig) {}

  /** 执行完整 bootstrap 流程 */
  async run(options?: {
    skipSeedData?: boolean;
    skipDemo?: boolean;
    adminPassword?: string;
  }): Promise<BootstrapResult> {
    const steps: BootstrapStepResult[] = [];

    // Step 1: 检测当前状态
    const status = detectInitStatus(this.config.dbPath);
    if (status.initialized) {
      return { completed: true, steps: [{ step: 'detect', success: true, message: '系统已初始化，跳过 bootstrap。' }] };
    }

    // Step 2: 确认存储路径
    steps.push(this.confirmStorage());

    // Step 3: 初始化数据库 + meta 表
    try {
      this.initDatabase();
      steps.push({ step: 'database', success: true, message: '数据库初始化成功。' });
    } catch (err) {
      steps.push({ step: 'database', success: false, message: `数据库初始化失败: ${err instanceof Error ? err.message : err}` });
      return { completed: false, steps };
    }

    // Step 4: 配置校验
    steps.push(this.validateProvider());

    // Step 5: 管理员账号创建
    steps.push(this.createAdmin(options?.adminPassword ?? 'admin'));

    // Step 6: 导入示例数据（可跳过）
    if (!options?.skipSeedData) {
      steps.push(await this.importSeedData());
    } else {
      steps.push({ step: 'seed-data', success: true, message: '用户跳过示例数据导入。' });
    }

    // Step 7: 标记初始化完成
    this.setMeta('initialized', 'true');
    steps.push({ step: 'finalize', success: true, message: '初始化完成。' });

    // Step 8: 演示路径（可跳过）
    let demoResult: DemoResult | undefined;
    if (!options?.skipDemo) {
      demoResult = await this.runDemo();
    }

    this.db?.close();
    this.db = null;

    return { completed: true, steps, demoResult };
  }

  /** 获取当前初始化状态 */
  getStatus(): InitStatus {
    return detectInitStatus(this.config.dbPath);
  }

  // ── Private steps ──

  private confirmStorage(): BootstrapStepResult {
    const dbPath = this.config.dbPath;
    if (dbPath === ':memory:') {
      return { step: 'storage', success: true, message: '使用内存模式，无需确认存储路径。' };
    }
    const dir = dirname(dbPath);
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.setMeta('storage_confirmed', 'true');
      return { step: 'storage', success: true, message: `存储路径确认: ${dbPath}` };
    } catch (err) {
      return { step: 'storage', success: false, message: `存储路径不可用: ${err instanceof Error ? err.message : err}` };
    }
  }

  private initDatabase(): void {
    const dbPath = this.config.dbPath;
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kivo_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private validateProvider(): BootstrapStepResult {
    const result = validateConfigDetailed(this.config);
    if (result.valid) {
      this.setMeta('provider_configured', 'true');
      return { step: 'provider', success: true, message: '配置校验通过。' };
    }
    const issues = result.errors.map(e => `${e.field}: ${e.message}`).join('; ');
    return { step: 'provider', success: false, message: `配置校验发现问题: ${issues}` };
  }

  private createAdmin(password: string): BootstrapStepResult {
    if (!this.db) {
      return { step: 'admin', success: false, message: '数据库未初始化。' };
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const existing = this.db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
    if (existing) {
      this.setMeta('admin_created', 'true');
      return { step: 'admin', success: true, message: '管理员账号已存在。' };
    }
    // 简单 hash（生产环境应使用 bcrypt/argon2）
    const hash = simpleHash(password);
    const id = `user-admin-${Date.now()}`;
    this.db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(id, 'admin', hash, 'admin');
    this.setMeta('admin_created', 'true');
    return { step: 'admin', success: true, message: '管理员账号创建成功（用户名: admin）。' };
  }

  private async importSeedData(): Promise<BootstrapStepResult> {
    if (!this.db) {
      return { step: 'seed-data', success: false, message: '数据库未初始化。' };
    }
    try {
      // 确保 entries 表存在（SQLiteProvider.initSchema 会创建，这里做防御）
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          source_json TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          status TEXT NOT NULL DEFAULT 'active',
          tags_json TEXT NOT NULL DEFAULT '[]',
          domain TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          supersedes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const now = new Date().toISOString();
      const source = JSON.stringify({ type: 'system', reference: 'bootstrap-seed', timestamp: now });
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO entries (id, type, title, content, summary, source_json, confidence, status, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const entry of SEED_ENTRIES) {
        insert.run(entry.id, entry.type, entry.title, entry.content, entry.summary, source, 0.9, 'active', JSON.stringify(entry.tags), now, now);
      }
      return { step: 'seed-data', success: true, message: `导入 ${SEED_ENTRIES.length} 条示例数据。` };
    } catch (err) {
      throw new KivoError('KIVO-BST-002', undefined, { originalError: String(err) });
    }
  }

  private async runDemo(): Promise<DemoResult> {
    // AC4: 引导用户跑通"导入一条知识 → 检索命中"
    if (!this.db) return { ingested: false, searchHit: false };
    try {
      const row = this.db.prepare('SELECT id FROM entries LIMIT 1').get() as { id: string } | undefined;
      if (!row) return { ingested: false, searchHit: false };
      // 尝试用 FTS 搜索验证
      const ftsExists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries_fts'").get();
      if (ftsExists) {
        const hit = this.db.prepare('SELECT e.id FROM entries e JOIN entries_fts ON entries_fts.rowid = e.rowid WHERE entries_fts MATCH ? LIMIT 1').get('KIVO') as { id: string } | undefined;
        return { ingested: true, searchHit: !!hit, entryId: row.id, searchQuery: 'KIVO' };
      }
      return { ingested: true, searchHit: false, entryId: row.id, searchQuery: 'KIVO' };
    } catch {
      return { ingested: true, searchHit: false };
    }
  }

  private setMeta(key: string, value: string): void {
    if (!this.db) return;
    this.db.prepare('INSERT OR REPLACE INTO kivo_meta (key, value, updated_at) VALUES (?, ?, datetime("now"))').run(key, value);
  }
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `simple:${hash.toString(16)}`;
}

