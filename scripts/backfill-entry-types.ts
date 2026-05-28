/**
 * scripts/backfill-entry-types.ts — FR-P02 学科条目类型回填
 *
 * 扫描已经从 PDF 抽取的学科 entry（source_json LIKE '%material://%' 且 entry_type 为空）
 * 用 LLM 单条判定 5 类 entry_type（concept/method/question/mistake/annotation）
 * 写入 entries.entry_type 列 + metadata_json.entry_type
 *
 * 用法：
 *   cd projects/kivo
 *   npx tsx scripts/backfill-entry-types.ts [--limit N] [--dry] [--concurrency K]
 *
 * 模型：claude-opus-4-7（penguin-main provider）
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const ENTRY_TYPES = ['concept', 'method', 'question', 'mistake', 'annotation'] as const;
type EntryType = typeof ENTRY_TYPES[number];
const VALID = new Set<string>(ENTRY_TYPES);

const QUESTION_PATTERNS: RegExp[] = [
  /[设若已知][^\n。]{0,80}[，,][^\n。]{0,160}[求证证明计算解判断试讨论]/,
  /^\s*\d+[\.、)]\s*[设若已知试求证证明计算]/m,
  /^[（(]\s*\d+\s*[）)]\s*[设若已知试求证证明计算]/m,
  /证明[:：]/,
  /[计求][\s\S]{0,40}的(定义|关系|差异|原因|结果|影响|步骤|条件|范围|值)/,
];
const MISTAKE_KEYWORDS = ['易错', '常见错误', '误解', '错因', '陷阱', '注意区分', '不要把'];
const METHOD_KEYWORDS = ['解法', '方法', '步骤', '解题', '证明思路', '套路', '通法', '化简方法'];

interface PenguinProvider {
  baseUrl: string;
  apiKey: string;
}

function loadPenguinProvider(): PenguinProvider {
  const cfgPath = process.env.OPENCLAW_CONFIG_PATH || '/root/.openclaw/openclaw.json';
  const raw = fs.readFileSync(cfgPath, 'utf-8');
  const cfg = JSON.parse(raw) as {
    models?: { providers?: Record<string, { baseUrl?: string; apiKey?: string }> };
  };
  const provider = cfg.models?.providers?.['penguin-main'];
  if (!provider?.baseUrl || !provider?.apiKey) {
    throw new Error('penguin-main provider missing baseUrl/apiKey in openclaw.json');
  }
  return {
    baseUrl: provider.baseUrl.replace(/\/+$/, ''),
    apiKey: provider.apiKey,
  };
}

function looksLikeQuestion(text: string): boolean {
  return QUESTION_PATTERNS.some((re) => re.test(text));
}

function heuristicEntryType(args: { title: string; content: string; type: string }): EntryType | null {
  const blob = `${args.title}\n${args.content}`;
  if (looksLikeQuestion(blob)) return 'question';
  if (MISTAKE_KEYWORDS.some((kw) => blob.includes(kw))) return 'mistake';
  return null;
}

function fallbackEntryType(args: { title: string; content: string; type: string }): EntryType {
  const blob = `${args.title}\n${args.content}`;
  if (args.type === 'methodology') return 'method';
  if (METHOD_KEYWORDS.some((kw) => blob.includes(kw))) return 'method';
  return 'concept';
}

const SYSTEM_PROMPT = [
  '你是通用知识条目分类器。判定输入条目的 entry_type，5 类之一：',
  '  - concept: 概念/定义/规则/边界/性质（如「核心概念的适用边界」）',
  '  - method: 操作方法/判断方法/通用步骤（如「拆解复杂问题的方法」）',
  '  - question: 问题原文（含「设…求…」「说明…」「判断…」等模式，必须用 question）',
  '  - mistake: 易错点/常见错误/陷阱/错因分析',
  '  - annotation: 批注/笔记/补充说明',
  '硬约束：',
  '  1) 题目（含设/若/已知/求/证明/计算的题型）必须分到 question，不可分到 concept/method',
  '  2) 不可发明 5 类之外的类型',
  '  3) 优先级：question > mistake > method > concept > annotation',
  '只输出一个 JSON 对象，形如 {"entry_type":"concept"}。',
].join('\n');

interface BackfillRow {
  id: string;
  type: string;
  title: string;
  content: string;
  metadata_json: string | null;
}

async function classifyOne(args: {
  provider: PenguinProvider;
  model: string;
  row: BackfillRow;
  timeoutMs: number;
}): Promise<{ entryType: EntryType; source: 'heuristic' | 'llm' | 'fallback' }> {
  const heuristic = heuristicEntryType({
    title: args.row.title,
    content: args.row.content,
    type: args.row.type,
  });
  if (heuristic) return { entryType: heuristic, source: 'heuristic' };

  const userText = [
    `【title】${args.row.title}`,
    `【knowledge_type】${args.row.type}`,
    `【content】`,
    args.row.content.slice(0, 2400),
    '',
    '判定 entry_type，只返回 JSON 对象。',
  ].join('\n');

  const url = `${args.provider.baseUrl}/v1/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userText },
        ],
        temperature: 0.0,
        max_tokens: 60,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json: any = await res.json();
    const content: string = json?.choices?.[0]?.message?.content ?? '';
    const match = content.match(/\{[^}]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        const candidate = String(parsed.entry_type || '').toLowerCase().trim();
        if (VALID.has(candidate)) return { entryType: candidate as EntryType, source: 'llm' };
      } catch { /* fallthrough */ }
    }
    const lower = content.toLowerCase();
    for (const t of ENTRY_TYPES) {
      if (lower.includes(t)) return { entryType: t, source: 'llm' };
    }
    return {
      entryType: fallbackEntryType({ title: args.row.title, content: args.row.content, type: args.row.type }),
      source: 'fallback',
    };
  } finally {
    clearTimeout(timer);
  }
}

interface CliArgs {
  limit: number | null;
  dry: boolean;
  concurrency: number;
  model: string;
}

function parseCli(argv: string[]): CliArgs {
  const out: CliArgs = { limit: null, dry: false, concurrency: 4, model: 'claude-opus-4-7' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') out.dry = true;
    else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i] || '0') || 0);
    else if (a === '--concurrency') out.concurrency = Math.max(1, Math.min(8, Number(argv[++i] || '4') || 4));
    else if (a === '--model') out.model = String(argv[++i] || out.model);
  }
  return out;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const dbPath = path.resolve(process.cwd(), 'kivo.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`kivo.db not found at ${dbPath}`);
  }
  const provider = loadPenguinProvider();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  let select = `
    SELECT id, type, title, content, metadata_json
    FROM entries
    WHERE source_json LIKE '%material://%'
      AND (entry_type IS NULL OR entry_type = '')
    ORDER BY created_at ASC
  `;
  if (cli.limit) select += ` LIMIT ${cli.limit}`;
  const rows = db.prepare(select).all() as BackfillRow[];
  console.log(JSON.stringify({
    phase: 'start',
    candidates: rows.length,
    dry: cli.dry,
    concurrency: cli.concurrency,
    model: cli.model,
  }));

  const update = db.prepare(
    `UPDATE entries
        SET entry_type = @entryType,
            metadata_json = @metadataJson,
            updated_at = datetime('now')
      WHERE id = @id`,
  );

  const stats = { heuristic: 0, llm: 0, fallback: 0, error: 0 };
  const distribution: Record<EntryType, number> = {
    concept: 0, method: 0, question: 0, mistake: 0, annotation: 0,
  };

  await runWithConcurrency(rows, cli.concurrency, async (row, idx) => {
    try {
      const result = await classifyOne({
        provider,
        model: cli.model,
        row,
        timeoutMs: 45_000,
      });
      stats[result.source]++;
      distribution[result.entryType]++;
      if (!cli.dry) {
        let metadata: Record<string, unknown> = {};
        if (row.metadata_json) {
          try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown>; }
          catch { metadata = {}; }
        }
        metadata.entry_type = result.entryType;
        update.run({
          id: row.id,
          entryType: result.entryType,
          metadataJson: JSON.stringify(metadata),
        });
      }
      if ((idx + 1) % 20 === 0) {
        console.log(JSON.stringify({ phase: 'progress', done: idx + 1, total: rows.length, stats, distribution }));
      }
    } catch (err) {
      stats.error++;
      console.error(`[backfill] entry ${row.id} error: ${(err as Error).message}`);
    }
  });

  console.log(JSON.stringify({ phase: 'done', total: rows.length, stats, distribution }));
  db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
