/**
 * kivo dict seed — Extract core terms from existing knowledge entries
 * and register them as dictionary entries (domain=system-dictionary).
 *
 * Scans entry titles and content for recurring technical terms,
 * then registers them via DictionaryService.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { DICTIONARY_DOMAIN, DICTIONARY_TAG } from '../dictionary/term-types.js';
import type { KnowledgeSource } from '../types/index.js';

export interface DictSeedOptions {
  cwd?: string;
  json?: boolean;
  limit?: number;
}

function resolveDbPath(dir: string): string {
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);
  if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }
  return resolve(dir, dbPath);
}

interface EntryRow {
  id: string;
  title: string;
  content: string;
  type: string;
  tags_json: string;
  domain: string | null;
}

/** Predefined seed terms extracted from KIVO's domain knowledge */
const SEED_TERMS: Array<{
  term: string;
  definition: string;
  aliases: string[];
  scope: string[];
}> = [
  { term: 'KnowledgeEntry', definition: '知识条目，KIVO 中最基本的知识单元，包含标题、内容、类型、标签等属性', aliases: ['知识条目', '条目'], scope: ['kivo-core'] },
  { term: 'Intent', definition: '意图类型知识，描述用户偏好、行为模式和「当用户说X时实际想要Y」的映射关系', aliases: ['意图', '用户意图'], scope: ['kivo-core', 'intent-matching'] },
  { term: 'similar_sentences', definition: '意图条目的相似句列表，包含 5~10 条用户可能说出的表达同一意图的自然语言句子', aliases: ['相似句', '同义句'], scope: ['intent-matching'] },
  { term: 'BGE Embedder', definition: 'BAAI/bge-small-zh-v1.5 向量嵌入模型，用于知识条目的语义向量化和相似度计算', aliases: ['BGE', 'bge-small-zh'], scope: ['kivo-core', 'embedding'] },
  { term: 'MECE', definition: 'Mutually Exclusive, Collectively Exhaustive，知识治理中的去重和覆盖度检查原则', aliases: ['互斥穷尽'], scope: ['governance'] },
  { term: 'Knowledge Graph', definition: '知识图谱，基于条目间的标签共现、语义相似和显式关联构建的图结构', aliases: ['知识图谱', '图谱'], scope: ['kivo-core', 'graph'] },
  { term: 'MergeDetector', definition: '合并检测器，检测新提取条目与已有条目之间的重复/合并候选', aliases: ['冲突检测', '合并检测'], scope: ['governance', 'pipeline'] },
  { term: 'DictionaryService', definition: '术语词典服务，管理系统术语的注册、更新、废弃和合并', aliases: ['词典服务', '术语服务'], scope: ['kivo-core', 'dictionary'] },
  { term: 'Value Gate', definition: '价值门控，在知识入库前评估条目价值，低价值条目标记为 pending', aliases: ['价值评估', '入库门控'], scope: ['pipeline', 'governance'] },
  { term: 'Governance Cycle', definition: '治理周期，定期运行的知识质量审计、去重、重写流程', aliases: ['治理循环', '自动治理'], scope: ['governance'] },
  { term: 'Cron Ingest', definition: '增量知识摄入，通过 crontab 定期扫描变更文件并提取新知识', aliases: ['定时摄入', '增量摄入'], scope: ['pipeline'] },
  { term: 'FTS5', definition: 'SQLite 全文搜索引擎，用于知识条目的关键词检索', aliases: ['全文搜索', '全文索引'], scope: ['kivo-core', 'search'] },
  { term: 'Vector Store', definition: '向量存储，保存知识条目的 BGE 嵌入向量，支持语义相似度搜索', aliases: ['向量库', '嵌入存储'], scope: ['kivo-core', 'search'] },
  { term: 'Chunk Strategy', definition: '文档分块策略，将长文档按 token 预算切分为可处理的片段', aliases: ['分块策略', '文档切分'], scope: ['pipeline'] },
  { term: 'LLM Extraction', definition: 'LLM 语义提取，使用大语言模型从文本中提取结构化知识条目', aliases: ['语义提取', 'LLM 提取'], scope: ['pipeline'] },
  { term: 'Badcase', definition: '错误案例，Agent 执行中的失败/错误记录，可转化为意图知识', aliases: ['错误案例', '失败案例'], scope: ['governance', 'learning'] },
  { term: 'Quality Audit', definition: '质量审计，评估知识条目的完整性、准确性和可用性', aliases: ['质量评估', '质量检查'], scope: ['governance'] },
  { term: 'Retag', definition: '多维标签重标注，为知识条目添加 nature/function/domain 三维标签', aliases: ['重标注', '标签刷新'], scope: ['governance'] },
  { term: 'Session Extraction', definition: '会话知识提取，从历史对话中自动提取可复用的知识条目', aliases: ['会话提取', '对话知识提取'], scope: ['pipeline'] },
  { term: 'GraphInsightEngine', definition: '图谱洞察引擎，分析知识图谱中的孤立节点、桥接节点、稀疏社区和跨域关联', aliases: ['洞察引擎', '图谱分析'], scope: ['graph'] },
  { term: 'Deduplication', definition: '语义去重，基于向量相似度检测并合并重复知识条目', aliases: ['去重', '语义去重'], scope: ['governance'] },
  { term: 'OpenClaw', definition: 'AI Agent 运行平台，KIVO 的宿主环境，提供 Agent 调度、插件和 Gateway 能力', aliases: ['OC'], scope: ['platform'] },
  { term: 'StorageAdapter', definition: '存储适配器接口，抽象知识条目的持久化操作，默认实现为 SQLiteProvider', aliases: ['存储接口'], scope: ['kivo-core'] },
  { term: 'Association', definition: '知识关联，描述两个条目之间的关系类型（supplements/depends_on/conflicts/supersedes）', aliases: ['关联', '知识关联'], scope: ['kivo-core', 'graph'] },
  { term: 'Supersedes', definition: '版本替代关系，新版本条目通过 supersedes 字段指向被替代的旧版本', aliases: ['版本替代'], scope: ['kivo-core'] },
];

export async function runDictSeed(options: DictSeedOptions = {}): Promise<string> {
  const dir = resolve(options.cwd ?? process.cwd());
  const dbPath = resolveDbPath(dir);

  if (!existsSync(dbPath)) {
    return options.json
      ? JSON.stringify({ error: 'Database not found. Run `kivo init` first.' })
      : '✗ Database not found. Run `kivo init` first.';
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Check how many dictionary entries already exist
  const existingCount = (db.prepare(
    `SELECT count(*) as cnt FROM entries WHERE domain = ? AND status = 'active'`
  ).get(DICTIONARY_DOMAIN) as { cnt: number }).cnt;

  if (existingCount >= 20) {
    db.close();
    return options.json
      ? JSON.stringify({ seeded: 0, existing: existingCount, message: 'Dictionary already has sufficient terms.' })
      : `✓ Dictionary already has ${existingCount} active terms. No seeding needed.`;
  }

  // Get existing term titles to avoid duplicates
  const existingTerms = new Set<string>();
  const existingRows = db.prepare(
    `SELECT title FROM entries WHERE domain = ? AND status = 'active'`
  ).all(DICTIONARY_DOMAIN) as Array<{ title: string }>;
  for (const row of existingRows) {
    existingTerms.add(row.title.toLowerCase());
  }

  const limit = options.limit ?? SEED_TERMS.length;
  const source: KnowledgeSource = {
    type: 'system',
    reference: 'kivo:dict-seed',
    timestamp: new Date(),
  };

  const now = new Date().toISOString();
  let seeded = 0;

  const insertStmt = db.prepare(`
    INSERT INTO entries (id, type, title, content, summary, source_json, confidence, status, tags_json, domain, version, created_at, updated_at)
    VALUES (?, 'fact', ?, ?, ?, ?, 1.0, 'active', ?, ?, 1, ?, ?)
  `);

  const { randomUUID } = await import('node:crypto');

  const txn = db.transaction(() => {
    for (const seed of SEED_TERMS.slice(0, limit)) {
      if (existingTerms.has(seed.term.toLowerCase())) {
        continue;
      }

      const id = randomUUID();
      const tags = [DICTIONARY_TAG, ...seed.scope];
      const metadata = {
        term: seed.term,
        aliases: seed.aliases,
        definition: seed.definition,
        constraints: [],
        positiveExamples: [],
        negativeExamples: [],
        scope: seed.scope,
        governanceSource: 'dict-seed',
      };

      // Store definition + metadata as structured content; source_json only holds KnowledgeSource
      const content = `${seed.definition}\n\n---\naliases: ${seed.aliases.join(', ')}\nscope: ${seed.scope.join(', ')}`;
      insertStmt.run(
        id,
        seed.term,
        content,
        seed.definition.slice(0, 120),
        JSON.stringify(source),
        JSON.stringify(tags),
        DICTIONARY_DOMAIN,
        now,
        now,
      );

      seeded++;
    }
  });
  txn();

  db.close();

  if (options.json) {
    return JSON.stringify({ seeded, existing: existingCount, total: existingCount + seeded });
  }

  return [
    `✓ Dictionary seeded: ${seeded} new terms`,
    `  Previously existing: ${existingCount}`,
    `  Total active terms: ${existingCount + seeded}`,
  ].join('\n');
}
