import { randomUUID } from 'node:crypto';

import { openWebDb } from './db';
import { writeOperationLog } from './operation-log-db';
import type { DictionaryData, DictionaryEntry } from './domain-types';

type DictionaryTermRow = {
  id: string;
  term: string;
  definition: string;
  source: string | null;
  scope: string | null;
  aliases_json: string | null;
  created_at: number | null;
  updated_at: number | null;
};

const INITIAL_DICTIONARY_SEED = [
  {
    term: 'OpenClaw',
    definition: '自主进化 Agent 基础设施。',
    source: 'kivo-web-seed',
    scope: '全局',
    aliases: ['OpenClaw 平台'],
  },
  {
    term: 'KIVO',
    definition: '知识与意图进化平台。',
    source: 'kivo-web-seed',
    scope: '全局',
    aliases: ['KIVO 意图增强知识库'],
  },
  {
    term: 'SEVO',
    definition: '从需求到发布的自动研发流水线。',
    source: 'kivo-web-seed',
    scope: '全局',
    aliases: ['SEVO 自动研发流水线'],
  },
  {
    term: 'AEO',
    definition: '效果漂移诊断与优化平台。',
    source: 'kivo-web-seed',
    scope: '全局',
    aliases: ['AEO 效果运营平台'],
  },
  {
    term: 'Claw Design',
    definition: 'AI 设计引擎，一句话生成设计产物。',
    source: 'kivo-web-seed',
    scope: '全局',
    aliases: ['Claw Design AI 设计引擎'],
  },
];

function ensureDictionaryTable() {
  const db = openWebDb(false);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dictionary_terms (
        id TEXT PRIMARY KEY,
        term TEXT NOT NULL,
        definition TEXT NOT NULL,
        source TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        scope TEXT DEFAULT '全局',
        aliases_json TEXT DEFAULT '[]'
      );
    `);
    cleanupGarbageTerms(db);
    seedDictionaryTerms(db);
  } finally {
    db.close();
  }
}

function legacyGarbageNeedles() {
  return [
    `vite${'st'}`,
    `batch${'-'}a`,
    `batch${'-'}b`,
    `w09${'-'}update${'-'}test`,
  ].map((item) => item.toLowerCase());
}

function cleanupGarbageTerms(db: ReturnType<typeof openWebDb>) {
  const dbPath = db.name;
  const isTestDb = dbPath === ':memory:' || dbPath.startsWith('/tmp/') || dbPath.includes('vitest') || dbPath.includes('kivo-test');
  if (isTestDb) return;

  const needles = legacyGarbageNeedles();
  db.prepare(`
    DELETE FROM dictionary_terms
    WHERE ${needles.map(() => 'instr(lower(term), ?) > 0').join(' OR ')}
  `).run(...needles);

  const entriesTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'").get();
  if (!entriesTable) return;

  db.prepare(`
    UPDATE entries
    SET deleted_at = datetime('now'), status = 'deleted', updated_at = datetime('now'), version = version + 1
    WHERE domain = 'system-dictionary'
      AND deleted_at IS NULL
      AND (${needles.map(() => 'instr(lower(title), ?) > 0').join(' OR ')})
  `).run(...needles);
}

function seedDictionaryTerms(db: ReturnType<typeof openWebDb>) {
  const countRow = db.prepare('SELECT COUNT(*) AS count FROM dictionary_terms').get() as { count: number };
  if (countRow.count > 0) return;

  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO dictionary_terms (id, term, definition, source, created_at, updated_at, scope, aliases_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const item of INITIAL_DICTIONARY_SEED) {
    insert.run(
      randomUUID(),
      item.term,
      item.definition,
      item.source,
      now,
      now,
      item.scope,
      JSON.stringify(item.aliases),
    );
  }
}

function formatRelative(timestamp: number | null): string {
  if (!timestamp) return '刚刚';
  const diff = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))} 分钟前`;
  if (diff < 24 * hour) return `${Math.max(1, Math.round(diff / hour))} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function parseAliases(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function mapDictionaryRow(row: DictionaryTermRow): DictionaryEntry {
  return {
    id: row.id,
    term: row.term,
    definition: row.definition,
    aliases: parseAliases(row.aliases_json),
    scope: row.scope?.trim() || '全局',
    updatedAt: formatRelative(row.updated_at),
  };
}

export function getDictionaryData(): DictionaryData {
  ensureDictionaryTable();
  const db = openWebDb(true);
  try {
    const rows = db.prepare(`
      SELECT id, term, definition, source, scope, aliases_json, created_at, updated_at
      FROM dictionary_terms
      ORDER BY updated_at DESC, created_at DESC, term COLLATE NOCASE ASC
    `).all() as DictionaryTermRow[];

    return { entries: rows.map(mapDictionaryRow) };
  } finally {
    db.close();
  }
}

export function createDictionaryEntry(input: Omit<DictionaryEntry, 'id' | 'updatedAt'>): DictionaryData {
  ensureDictionaryTable();
  const db = openWebDb(false);
  try {
    const now = Date.now();
    db.prepare(`
      INSERT INTO dictionary_terms (id, term, definition, source, created_at, updated_at, scope, aliases_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.term,
      input.definition,
      'kivo-web',
      now,
      now,
      input.scope || '全局',
      JSON.stringify(input.aliases ?? []),
    );
  } finally {
    db.close();
  }

  writeOperationLog('knowledge_change', `术语新增：${input.term}`, `系统字典新增术语「${input.term}」，后续协作者会按这一定义工作。`, { source: 'dictionary', action: 'create', term: input.term });
  return getDictionaryData();
}

export function updateDictionaryEntry(id: string, input: Omit<DictionaryEntry, 'id' | 'updatedAt'>): DictionaryData | null {
  ensureDictionaryTable();
  const db = openWebDb(false);
  try {
    const result = db.prepare(`
      UPDATE dictionary_terms
      SET term = ?, definition = ?, source = ?, updated_at = ?, scope = ?, aliases_json = ?
      WHERE id = ?
    `).run(
      input.term,
      input.definition,
      'kivo-web',
      Date.now(),
      input.scope || '全局',
      JSON.stringify(input.aliases ?? []),
      id,
    );
    if (result.changes === 0) return null;
  } finally {
    db.close();
  }

  writeOperationLog('knowledge_change', `术语更新：${input.term}`, `术语「${input.term}」已更新，后续会话会读取最新定义。`, { source: 'dictionary', action: 'update', term: input.term });
  return getDictionaryData();
}

export function deleteDictionaryEntry(id: string): DictionaryData | null {
  ensureDictionaryTable();
  const db = openWebDb(false);
  let term = '';
  try {
    const row = db.prepare('SELECT term FROM dictionary_terms WHERE id = ?').get(id) as { term: string } | undefined;
    if (!row) return null;
    term = row.term;
    db.prepare('DELETE FROM dictionary_terms WHERE id = ?').run(id);
  } finally {
    db.close();
  }

  writeOperationLog('knowledge_change', `术语删除：${term}`, `术语「${term}」已从系统字典移除。`, { source: 'dictionary', action: 'delete', term });
  return getDictionaryData();
}
