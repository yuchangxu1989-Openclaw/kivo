/**
 * FR-P04 SubjectConceptExtractor unit test
 *
 * 测试要点（mock LLM，禁污染 prod DB）：
 *  1. extractFromChunks 能从 LLM 返回的 JSON 数组里拿到 5 类条目
 *  2. parseLlmResponse 处理 ```json``` 包裹、不合法 kind 过滤
 *  3. extractFromMaterial 写入 entries 表时携带 subject_id + entry_type
 *  4. 不带 subject_node_id 的 material 拒绝处理
 *  5. 无 chunks 时返回 errors 不抛
 *
 * 通用化校验：subjectName 通过 prompt 注入，不在代码里硬编码学科。
 *
 * Hermes (OpenClaw ACP Agent) / 2026-05-24
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SubjectConceptExtractor } from '../subject-concept-extractor.js';

vi.mock('../../../cli/resolve-llm-config.js', () => ({
  resolveLlmConfig: () => ({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test', model: 'mock-model' }),
}));

const NOW = '2026-05-24T00:00:00.000Z';

function createBaseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL DEFAULT '{}',
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT,
      subject_id TEXT,
      entry_type TEXT
    );
    CREATE TABLE subject_nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      level INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      merged_into TEXT
    );
    CREATE TABLE materials (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      subject_node_id TEXT,
      storage_path TEXT,
      mime_type TEXT,
      extract_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
  `);
}

function insertSubject(db: Database.Database, id: string, name: string): void {
  db.prepare(`INSERT INTO subject_nodes (id, name, level, status) VALUES (?, ?, 0, 'active')`).run(id, name);
}

function insertMaterial(
  db: Database.Database,
  id: string,
  subjectId: string | null,
  fileName: string,
): void {
  db.prepare(`
    INSERT INTO materials (id, file_name, subject_node_id, storage_path, mime_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'application/pdf', ?, ?)
  `).run(id, fileName, subjectId, '/tmp/no-such-file.pdf', NOW, NOW);
}

function insertOldEntries(db: Database.Database, materialId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    db.prepare(`
      INSERT INTO entries (
        id, type, title, content, summary, source_json, status, tags_json, created_at, updated_at, version
      ) VALUES (?, 'fact', ?, ?, '', ?, 'active', '[]', ?, ?, 1)
    `).run(
      `old-${materialId}-${i}`,
      `旧条目 ${i}`,
      `这是旧条目 ${i} 的复述文本，用作 chunk 文本回放`,
      JSON.stringify({ materialId, page: i + 1 }),
      NOW,
      NOW,
    );
  }
}

function buildLlmResponse(items: Array<Record<string, unknown>>, wrap: 'raw' | 'codeblock' = 'raw'): string {
  const body = JSON.stringify(items);
  return wrap === 'codeblock' ? `\`\`\`json\n${body}\n\`\`\`` : body;
}

function makeFetchImpl(content: string): typeof fetch {
  return (async () => {
    const payload = JSON.stringify({ choices: [{ message: { content } }] });
    return new Response(payload, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('SubjectConceptExtractor', () => {
  let dir: string;
  let dbPath: string;
  let setupDb: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kivo-subject-extractor-'));
    dbPath = join(dir, 'kivo.db');
    setupDb = new Database(dbPath);
    createBaseSchema(setupDb);
  });

  afterEach(() => {
    try { setupDb.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('extractFromChunks 解析合法 LLM 输出（含代码块包裹），过滤非法 kind', async () => {
    const fetchImpl = makeFetchImpl(
      buildLlmResponse(
        [
          { kind: 'concept', title: '随机变量', content: '将样本空间映射到实数的函数', summary: '' },
          { kind: 'formula', title: '期望', content: 'E[X]=Σ x_i p_i', summary: '', relatedTerms: ['期望', '概率'] },
          { kind: 'invalid', title: '不合法', content: '会被丢弃' },
          { kind: 'theorem', title: '中心极限定理', content: '当 n 足够大，样本均值趋向正态分布', summary: '' },
          { kind: 'example', title: '抛硬币例题', content: '题：抛 100 次硬币……解：……' },
          { kind: 'property', title: '独立性', content: '两个事件互不影响' },
        ],
        'codeblock',
      ),
    );

    const extractor = new SubjectConceptExtractor(dbPath, { fetchImpl });
    try {
      const items = await extractor.extractFromChunks('某个学科', [
        { index: 0, text: '一段学科正文' },
      ]);
      expect(items).toHaveLength(5);
      expect(items.map((it) => it.kind).sort()).toEqual(['concept', 'example', 'formula', 'property', 'theorem']);
      // 通用化：传入 subjectName='某个学科'，不应该有任何硬编码学科出现
      const titles = items.map((it) => it.title);
      expect(titles).toContain('随机变量');
      expect(titles).toContain('中心极限定理');
    } finally {
      extractor.close();
    }
  });

  it('extractFromMaterial 把条目写入 entries 表，subject_id + entry_type 正确', async () => {
    insertSubject(setupDb, 'subj-A', '某学科A');
    insertMaterial(setupDb, 'mat-A', 'subj-A', '某教材.pdf');
    insertOldEntries(setupDb, 'mat-A', 6); // 走旧条目反向 chunk 路径
    setupDb.close();

    const fetchImpl = makeFetchImpl(
      buildLlmResponse([
        { kind: 'concept', title: '术语1', content: '一段中文定义文本', summary: 'summary1', sourcePage: 3 },
        { kind: 'example', title: '例题1', content: '题：……解：……', summary: 'summary2' },
      ]),
    );

    const extractor = new SubjectConceptExtractor(dbPath, { fetchImpl, verbose: false });
    try {
      const result = await extractor.extractFromMaterial('mat-A');
      expect(result.materialId).toBe('mat-A');
      expect(result.subjectId).toBe('subj-A');
      expect(result.chunkCount).toBeGreaterThan(0);
      expect(result.itemsExtracted).toBeGreaterThan(0);
      expect(result.entriesWritten).toBe(result.itemsExtracted);
    } finally {
      extractor.close();
    }

    const verifyDb = new Database(dbPath);
    const newEntries = verifyDb.prepare(`
      SELECT entry_type, type, subject_id, title, content
      FROM entries
      WHERE entry_type IN ('concept','question')
        AND subject_id = ?
      ORDER BY created_at ASC
    `).all('subj-A') as Array<{ entry_type: string; type: string; subject_id: string; title: string; content: string }>;
    verifyDb.close();

    expect(newEntries.length).toBeGreaterThan(0);
    for (const row of newEntries) {
      expect(row.subject_id).toBe('subj-A');
      expect(['concept', 'question']).toContain(row.entry_type);
      // 中文 content（防英文 prompt 漏配）
      expect(/[\u4e00-\u9fa5]/.test(row.content)).toBe(true);
    }
  });

  it('material 没有 subject_node_id 时拒绝处理', async () => {
    insertMaterial(setupDb, 'mat-orphan', null, '孤儿材料.pdf');
    setupDb.close();

    const extractor = new SubjectConceptExtractor(dbPath, { fetchImpl: makeFetchImpl('[]') });
    try {
      await expect(extractor.extractFromMaterial('mat-orphan')).rejects.toThrow(/no subject_node_id/);
    } finally {
      extractor.close();
    }
  });

  it('既无旧 entries 又无 PDF 文件时，返回 errors 不抛', async () => {
    insertSubject(setupDb, 'subj-B', '某学科B');
    insertMaterial(setupDb, 'mat-empty', 'subj-B', '不存在的.pdf');
    setupDb.close();

    const extractor = new SubjectConceptExtractor(dbPath, { fetchImpl: makeFetchImpl('[]') });
    try {
      const result = await extractor.extractFromMaterial('mat-empty');
      expect(result.chunkCount).toBe(0);
      expect(result.entriesWritten).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      extractor.close();
    }
  });

  it('LLM 输出非 JSON 时降级为空数组（不抛）', async () => {
    const extractor = new SubjectConceptExtractor(dbPath, {
      fetchImpl: makeFetchImpl('总结：这不是 JSON，纯文字。'),
    });
    try {
      const items = await extractor.extractFromChunks('某学科', [{ index: 0, text: 'xxx' }]);
      expect(items).toEqual([]);
    } finally {
      extractor.close();
    }
  });
});
