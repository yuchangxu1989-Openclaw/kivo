import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { openWebDb } from '@/lib/db';
import { SubjectRepoError } from '@/lib/subjects/repository';
import { embed as embedClientEmbed } from '@/lib/embedding-client';

export interface SubjectAlias {
  id: string;
  subjectId: string;
  alias: string;
  createdAt: number;
}

interface SubjectAliasRow {
  id: string;
  subject_id: string;
  alias_name: string;
  created_at: number;
}

export interface SubjectAliasRepositoryDeps {
  db?: Database.Database;
  /**
   * 注入嵌入函数，便于测试隔离外部调用。
   * 默认走 lib/embedding-client 的 fallback chain（远程→ollama→BGE本机）。
   */
  embed?: (text: string) => Promise<number[]>;
}

async function defaultEmbed(text: string): Promise<number[]> {
  const { embedding } = await embedClientEmbed(text);
  return embedding;
}

function encodeEmbedding(values: number[]): Buffer {
  const arr = new Float32Array(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export class SubjectAliasRepository {
  private readonly db: Database.Database;
  private readonly embed: (text: string) => Promise<number[]>;

  constructor(deps: SubjectAliasRepositoryDeps = {}) {
    this.db = deps.db ?? openWebDb(false);
    this.db.pragma('foreign_keys = ON');
    this.embed = deps.embed ?? defaultEmbed;
    this.ensureSchema();
  }

  list(subjectId: string): SubjectAlias[] {
    this.assertSubjectExists(subjectId);

    const rows = this.db
      .prepare<[string]>(
        `SELECT id, subject_id, alias_name, created_at
           FROM subject_aliases
          WHERE subject_id = ?
          ORDER BY alias_name ASC`,
      )
      .all(subjectId) as SubjectAliasRow[];

    return rows.map(rowToAlias);
  }

  create(subjectId: string, rawAlias: string): SubjectAlias {
    this.assertSubjectExists(subjectId);
    const alias = normalizeAlias(rawAlias);
    const existing = this.findBySubjectAndAlias(subjectId, alias);
    if (existing) {
      throw new SubjectRepoError(
        'CONFLICT',
        `alias "${alias}" already exists for subject ${subjectId}`,
      );
    }

    const id = randomUUID();
    const createdAt = Date.now();

    try {
      this.db
        .prepare(
          `INSERT INTO subject_aliases (id, subject_id, alias_name, alias_kind, created_at)
           VALUES (?, ?, ?, 'manual', ?)`,
        )
        .run(id, subjectId, alias, createdAt);
    } catch (err) {
      if (isSqliteUniqueError(err)) {
        throw new SubjectRepoError(
          'CONFLICT',
          `alias "${alias}" already exists for subject ${subjectId}`,
        );
      }
      throw err;
    }

    // FR-B03 AC7：alias 创建后立即生成向量。失败仅记日志，不阻塞 create。
    void this.vectorizeAlias(id, alias);

    return {
      id,
      subjectId,
      alias,
      createdAt,
    };
  }

  remove(subjectId: string, aliasId: string): SubjectAlias {
    this.assertSubjectExists(subjectId);

    const existing = this.db
      .prepare<[string, string]>(
        `SELECT id, subject_id, alias_name, created_at
           FROM subject_aliases
          WHERE id = ? AND subject_id = ?`,
      )
      .get(aliasId, subjectId) as SubjectAliasRow | undefined;

    if (!existing) {
      throw new SubjectRepoError(
        'NOT_FOUND',
        `alias ${aliasId} not found for subject ${subjectId}`,
      );
    }

    this.db
      .prepare<[string, string]>(
        `DELETE FROM subject_aliases WHERE id = ? AND subject_id = ?`,
      )
      .run(aliasId, subjectId);

    return rowToAlias(existing);
  }

  /** 暴露给定时任务批量补齐缺失向量。 */
  async backfillMissingEmbeddings(limit = 50): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT id, alias_name FROM subject_aliases
          WHERE alias_embedding IS NULL
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; alias_name: string }>;

    let done = 0;
    for (const row of rows) {
      try {
        await this.vectorizeAlias(row.id, row.alias_name);
        done += 1;
      } catch {
        // 单条失败不阻断后续
      }
    }
    return done;
  }

  private async vectorizeAlias(aliasId: string, aliasName: string): Promise<void> {
    try {
      const vec = await this.embed(aliasName);
      const buf = encodeEmbedding(vec);
      this.db
        .prepare(`UPDATE subject_aliases SET alias_embedding = ? WHERE id = ?`)
        .run(buf, aliasId);
    } catch (err) {
      // 不阻塞 alias 创建，仅记日志
      // eslint-disable-next-line no-console
      console.warn(
        `[subject-alias] embed failed for ${aliasId} ("${aliasName}"): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subject_aliases (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        alias_name TEXT NOT NULL,
        alias_kind TEXT NOT NULL DEFAULT 'manual',
        created_at INTEGER NOT NULL,
        UNIQUE(subject_id, alias_name),
        FOREIGN KEY(subject_id) REFERENCES subject_nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_subject_aliases_subject_id
        ON subject_aliases(subject_id);
    `);

    if (!this.hasColumn('subject_aliases', 'alias_embedding')) {
      this.db.exec(`ALTER TABLE subject_aliases ADD COLUMN alias_embedding BLOB`);
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }

  private assertSubjectExists(subjectId: string): void {
    const row = this.db
      .prepare<[string]>(
        `SELECT id, merged_into
           FROM subject_nodes
          WHERE id = ?`,
      )
      .get(subjectId) as { id: string; merged_into: string | null } | undefined;

    if (!row) {
      throw new SubjectRepoError('NOT_FOUND', `subject ${subjectId} not found`);
    }
    if (row.merged_into) {
      throw new SubjectRepoError(
        'CONFLICT',
        `subject ${subjectId} has been merged into ${row.merged_into}`,
      );
    }
  }

  private findBySubjectAndAlias(subjectId: string, alias: string): SubjectAlias | null {
    const row = this.db
      .prepare<[string, string]>(
        `SELECT id, subject_id, alias_name, created_at
           FROM subject_aliases
          WHERE subject_id = ? AND alias_name = ?`,
      )
      .get(subjectId, alias) as SubjectAliasRow | undefined;

    return row ? rowToAlias(row) : null;
  }
}

function normalizeAlias(value: string): string {
  const alias = value.trim();
  if (!alias) {
    throw new SubjectRepoError('BAD_REQUEST', 'alias cannot be empty');
  }
  return alias;
}

function rowToAlias(row: SubjectAliasRow): SubjectAlias {
  return {
    id: row.id,
    subjectId: row.subject_id,
    alias: row.alias_name,
    createdAt: row.created_at,
  };
}

function isSqliteUniqueError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

let cachedRepo: SubjectAliasRepository | null = null;
export function getSubjectAliasRepository(): SubjectAliasRepository {
  if (!cachedRepo) cachedRepo = new SubjectAliasRepository();
  return cachedRepo;
}

/** Reset cached singleton — used by tests when KIVO_DB_PATH overrides. */
export function resetSubjectAliasRepositoryForTests(): void {
  cachedRepo = null;
}
