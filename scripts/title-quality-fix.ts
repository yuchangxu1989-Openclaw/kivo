import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface EntryRow {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  type: string | null;
  domain: string | null;
}

interface LlmDecision {
  ok: boolean;
  title?: string;
  reason?: string;
}

interface ProviderConfig {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

const DB_PATH = resolve(process.cwd(), process.argv.includes('--db') ? process.argv[process.argv.indexOf('--db') + 1] : 'kivo.db');
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 0;
const BATCH_SIZE = 8;
const MAX_LLM_CHARS = 900;
const TEST_TITLE_RE = /(test|测试|删除|placeholder|demo|样例|示例)/i;
const TRUNCATION_RE = /(\.\.\.|…|\.\.\s*$|。{2,}|、{2,})/;
const CONTROL_RE = /[\r\n\t]/;

function normalizeBaseUrl(raw: string): string {
  let url = String(raw || 'https://api.penguinsaichat.dpdns.org/v1').replace(/\/+$/, '');
  if (!url.endsWith('/v1')) url += '/v1';
  return url;
}

function resolveLlmConfig(): ProviderConfig {
  const envKey = process.env.OPENAI_API_KEY ?? '';
  const envBase = process.env.OPENAI_BASE_URL ?? '';
  const envModel = process.env.KIVO_LLM_MODEL ?? process.env.OPENAI_MODEL ?? 'claude-opus-4-6';
  if (envKey && !envBase.includes('api2.penguinsaichat')) {
    return {
      providerId: 'env:OPENAI_API_KEY',
      apiKey: envKey,
      baseUrl: normalizeBaseUrl(envBase),
      model: envModel,
    };
  }

  const openclawConfigPath = resolve(process.env.HOME ?? '/root', '.openclaw', 'openclaw.json');
  if (!existsSync(openclawConfigPath)) throw new Error('openclaw.json not found for LLM config');
  const cfg = JSON.parse(readFileSync(openclawConfigPath, 'utf-8')) as { models?: { providers?: Record<string, { apiKey?: string; baseUrl?: string }> } };
  const providers = cfg.models?.providers;
  if (!providers) throw new Error('models.providers not found in openclaw.json');

  const preferred = providers['penguin-main'];
  if (preferred?.apiKey) {
    return { providerId: 'penguin-main', apiKey: preferred.apiKey, baseUrl: normalizeBaseUrl(preferred.baseUrl ?? ''), model: envModel };
  }

  for (const [providerId, provider] of Object.entries(providers)) {
    if (provider?.apiKey && provider.baseUrl?.includes('api.penguinsaichat') && !provider.baseUrl.includes('api2.penguinsaichat')) {
      return { providerId, apiKey: provider.apiKey, baseUrl: normalizeBaseUrl(provider.baseUrl), model: envModel };
    }
  }

  throw new Error('No chat-capable LLM provider found');
}

function isDirtyTitle(title: string): boolean {
  const trimmed = title.trim();
  return (
    trimmed.length < 5 ||
    trimmed.length > 80 ||
    TEST_TITLE_RE.test(trimmed) ||
    TRUNCATION_RE.test(trimmed) ||
    CONTROL_RE.test(trimmed) ||
    /^untitled$/i.test(trimmed)
  );
}

function cleanTitle(raw: unknown, fallback: string): string {
  const text = typeof raw === 'string' ? raw : fallback;
  let title = text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[`*_#>\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[。；;，,、：:!！?？]+$/g, '')
    .trim();

  if (title.length > 80) title = title.slice(0, 80).replace(/[。；;，,、：:!！?？\s]+$/g, '').trim();
  if (title.length < 5) title = fallback;
  if (title.length > 80) title = title.slice(0, 80).trim();
  return title;
}

function fallbackTitle(entry: EntryRow): string {
  const source = `${entry.summary || ''}\n${entry.content || ''}`
    .replace(/[#>*_`\[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const candidate = source || entry.domain || entry.type || '知识条目';
  const compact = candidate.slice(0, 60).replace(/[。；;，,、：:!！?？\s]+$/g, '').trim();
  return compact.length >= 5 ? compact : '未命名知识条目';
}

function parseJson(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error(`LLM response is not valid JSON: ${cleaned.slice(0, 240)}`);
  }
}

async function callLlm(provider: ProviderConfig, entries: EntryRow[]): Promise<Map<string, LlmDecision>> {
  const input = entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    type: entry.type,
    domain: entry.domain,
    summary: (entry.summary || '').slice(0, 220),
    content: (entry.content || '').slice(0, MAX_LLM_CHARS),
  }));

  const prompt = `你是 KIVO 知识条目标题质检器。请检查每条 entry 的 title 是否适合展示。\n\n规则：\n- 合格标题长度 5-80 个字符。\n- 标题必须是完整、自然、可读的中文或中英混合短语。\n- 禁止截断痕迹、省略号、测试词、删除词、placeholder、demo、样例、示例。\n- 标题要概括 content，不要编造 content 没有的信息。\n\n请只输出 minified JSON 数组，不要换行、不要 markdown、不要解释。每个元素：{"id":"...","ok":true} 或 {"id":"...","ok":false,"title":"新标题","reason":"简短原因"}。字符串内不要出现英文双引号。\n\nentries:\n${JSON.stringify(input, null, 2)}`;

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 2500,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`LLM API failed provider=${provider.providerId} status=${response.status}: ${body.slice(0, 240)}`);
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content || '';
  const parsed = parseJson(content);
  if (!Array.isArray(parsed)) throw new Error('LLM response is not a JSON array');

  const result = new Map<string, LlmDecision>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== 'string') continue;
    result.set(obj.id, {
      ok: obj.ok === true,
      title: typeof obj.title === 'string' ? obj.title : undefined,
      reason: typeof obj.reason === 'string' ? obj.reason : undefined,
    });
  }
  return result;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function main() {
  if (!existsSync(DB_PATH)) throw new Error(`DB not found: ${DB_PATH}`);
  const db = new Database(DB_PATH);
  const rows = db.prepare(`
    SELECT id, title, content, summary, type, domain
    FROM entries
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC, created_at DESC
  `).all() as EntryRow[];

  const candidates = rows.filter((row) => isDirtyTitle(row.title));
  const limited = LIMIT_ARG > 0 ? candidates.slice(0, LIMIT_ARG) : candidates;
  console.log(`[title-quality-fix] scanned=${rows.length} dirty=${candidates.length} processing=${limited.length} dryRun=${DRY_RUN}`);

  if (limited.length === 0) {
    db.close();
    return;
  }

  const provider = resolveLlmConfig();
  const update = db.prepare('UPDATE entries SET title = ?, updated_at = ? WHERE id = ?');
  let fixed = 0;

  for (const group of chunk(limited, BATCH_SIZE)) {
    const decisions = await callLlm(provider, group);
    const now = new Date().toISOString();
    const changes: Array<{ id: string; before: string; after: string; reason: string }> = [];

    for (const entry of group) {
      const decision = decisions.get(entry.id);
      if (decision?.ok && !isDirtyTitle(entry.title)) continue;
      const next = cleanTitle(decision?.title, fallbackTitle(entry));
      if (next !== entry.title) changes.push({ id: entry.id, before: entry.title, after: next, reason: decision?.reason || 'local-quality-rule' });
    }

    if (!DRY_RUN) {
      const tx = db.transaction((items: typeof changes) => {
        for (const item of items) update.run(item.after, now, item.id);
      });
      tx(changes);
    }

    fixed += changes.length;
    for (const item of changes) {
      console.log(`[title-quality-fix] ${DRY_RUN ? 'would-fix' : 'fixed'} ${item.id}: ${item.before} -> ${item.after} (${item.reason})`);
    }
  }

  const abnormal = db.prepare(`
    SELECT COUNT(*) AS cnt FROM entries
    WHERE deleted_at IS NULL
      AND (LENGTH(title) > 80 OR LENGTH(title) < 5 OR LOWER(title) LIKE '%test%' OR title LIKE '%测试%' OR title LIKE '%删除%' OR title LIKE '%…%' OR title LIKE '%...%')
  `).get() as { cnt: number };
  console.log(`[title-quality-fix] fixed=${fixed} remaining_abnormal=${abnormal.cnt}`);
  db.close();
}

main().catch((err) => {
  console.error(`[title-quality-fix] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
