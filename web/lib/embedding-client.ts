/**
 * KIVO Web Embedding Client — fallback chain for zero-config 商用就绪。
 *
 * 解决问题：陌生用户装完 KIVO 跑搜索 500（embedding provider 未配置）。
 *
 * Fallback chain（按顺序探测，命中即用）：
 *   1) 方舟 OpenAI-compatible endpoint（优先从 openclaw.json / env 读取）
 *   2) 本机兼容层（http://localhost:9876，底层同样走方舟）
 *
 * 所有候选连续失败 → 抛 EmbeddingUnavailableError，调用方应优雅降级
 * （搜索路径降级到 FTS5 lexical fallback 并标 meta.embeddingMode）。
 *
 * 设计原则：
 * - 零配置：默认从 openclaw.json 的 volcengine-ark 读取 apiKey。
 * - LRU 健康缓存：连续失败 30s 内不再尝试同一 provider，避免每次请求都跑 2 次
 *   超时。
 * - 不静默降级到关键词匹配（铁律 N-L01）：本模块只做 embedding，关键词降级
 *   由调用方决定且必须在 response.meta 显式标注。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

interface EmbeddingProviderCandidate {
  /** Identifier emitted in logs / debug output */
  id: 'openai-compatible' | 'bge-local';
  /** True when env/config indicates this candidate should be tried */
  enabled: boolean;
  embed: (text: string) => Promise<number[]>;
  embedBatch?: (texts: string[]) => Promise<number[][]>;
}

/**
 * EmbeddingUnavailableError — 三段式错误（FR-Z04 AC1 / FR-C04 AC5）。
 *
 * 错误体把「发生了什么 / 可能原因 / 恢复动作」拆成结构化字段，让 search route
 * 直接序列化成 4xx response body，且让用户在 Web 端「错误介入」入口能看到完整
 * 三段文本，不要裸暴露 stack。
 */
export class EmbeddingUnavailableError extends Error {
  readonly probedProviders: string[];
  readonly lastError?: string;
  readonly what: string;
  readonly why: string;
  readonly how: string;

  constructor(probed: string[], lastError?: string) {
    const what = `KIVO embedding 服务全部不可用，无法生成查询向量（已尝试 provider: ${probed.join(', ') || 'none'}）。`;
    const why = lastError
      ? `最近一次错误：${lastError}。常见原因：① openclaw.json 缺少 volcengine-ark.apiKey；② 方舟 endpoint 网络不通或鉴权失败；③ 本机 9876 兼容层未启动。`
      : '常见原因：① openclaw.json 缺少 volcengine-ark.apiKey；② 方舟 endpoint 不可达；③ 本机 9876 兼容层未启动。';
    const how =
      '恢复动作（任选其一）：\n' +
      '  ① 默认路径：确认 openclaw.json 中 models.providers.volcengine-ark.apiKey 可用，或设置 ARK_API_KEY / KIVO_EMBEDDING_API_KEY；\n' +
      '  ② 本机兼容层路径：启动 `kivo-bge-embed.service`，它会把 /v1/embeddings 转发到方舟；\n' +
      '  ③ Web 端「错误介入」入口点「重新检测 embedding provider」可一键复检。';
    super(`${what}\n${why}\n${how}`);
    this.name = 'EmbeddingUnavailableError';
    this.probedProviders = probed;
    this.lastError = lastError;
    this.what = what;
    this.why = why;
    this.how = how;
  }
}

/**
 * 把 EmbeddingUnavailableError 序列化成 search/knowledge API 4xx body。
 * 与 FR-Z04 AC1 三段式契约一致；前端可以直接渲染 what/why/how 三段。
 */
export function embeddingUnavailableErrorPayload(
  err: EmbeddingUnavailableError,
): {
  code: string;
  message: string;
  what: string;
  why: string;
  how: string;
  probedProviders: string[];
} {
  return {
    code: 'EMBEDDING_UNAVAILABLE',
    message: err.message,
    what: err.what,
    why: err.why,
    how: err.how,
    probedProviders: err.probedProviders,
  };
}

const HEALTH_CACHE_TTL_MS = 30_000;
type HealthState = { ok: boolean; checkedAt: number; lastError?: string };
const healthCache = new Map<string, HealthState>();

function cacheKey(id: string, baseUrl: string, model: string): string {
  return `${id}|${baseUrl}|${model}`;
}

function getCached(key: string): HealthState | null {
  const v = healthCache.get(key);
  if (!v) return null;
  if (Date.now() - v.checkedAt > HEALTH_CACHE_TTL_MS) {
    healthCache.delete(key);
    return null;
  }
  return v;
}

function setHealth(key: string, ok: boolean, lastError?: string): void {
  healthCache.set(key, { ok, checkedAt: Date.now(), lastError });
}

/** Reset health cache (for tests). */
export function _resetEmbeddingHealthCache(): void {
  healthCache.clear();
}

interface ResolvedConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  preferRemote: boolean;
  bgeBaseUrl: string;
  timeoutMs: number;
}

function resolveConfig(): ResolvedConfig {
  const env = process.env;
  const baseUrl = (env.ARK_BASE_URL || env.KIVO_EMBEDDING_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
  const apiKey = env.ARK_API_KEY || env.KIVO_EMBEDDING_API_KEY || env.KIVO_EMBEDDING_TOKEN || readArkApiKeyFromOpenClaw() || undefined;
  const model = env.KIVO_EMBEDDING_MODEL || 'doubao-embedding-vision-251215';
  const bgeBaseUrl = (env.KIVO_BGE_BASE_URL || 'http://localhost:9876').replace(/\/$/, '');
  const timeoutMs = Number(env.KIVO_EMBEDDING_TIMEOUT_MS) > 0 ? Number(env.KIVO_EMBEDDING_TIMEOUT_MS) : 30_000;
  return { baseUrl, apiKey, model, preferRemote: Boolean(apiKey), bgeBaseUrl, timeoutMs };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI-compatible /v1/embeddings — input string or string[] */
async function openaiCompatibleEmbed(
  baseUrl: string,
  apiKey: string,
  model: string,
  input: string | string[],
  timeoutMs: number,
): Promise<number[][]> {
  const url = `${baseUrl}/v1/embeddings`.replace(/\/v1\/v1\//, '/v1/');
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  const resp = await postJson(url, { model, input }, headers, timeoutMs);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`openai-compatible embedding ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
  const items = data.data ?? [];
  if (items.length === 0 || !Array.isArray(items[0]?.embedding)) {
    throw new Error('openai-compatible response missing embeddings');
  }
  // Sort by index to ensure batch ordering
  items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return items.map((d) => d.embedding ?? []);
}

/** BGE local HTTP service POST /embed { texts: string[] } */
async function bgeLocalEmbed(
  baseUrl: string,
  texts: string[],
  timeoutMs: number,
): Promise<number[][]> {
  const resp = await postJson(`${baseUrl}/v1/embeddings`, { model: 'doubao-embedding-vision-251215', input: texts }, {}, timeoutMs);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`bge-local embedding ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
  const items = (data.data ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (items.length !== texts.length || !Array.isArray(items[0]?.embedding)) {
    throw new Error('bge-local response missing embeddings');
  }
  return items.map((item) => item.embedding ?? []);
}

/** Build candidate list in priority order based on env config. */
function buildCandidates(cfg: ResolvedConfig): EmbeddingProviderCandidate[] {
  const candidates: EmbeddingProviderCandidate[] = [];

  // 1) Remote Ark-compatible endpoint (prefer direct provider when key exists)
  if (cfg.preferRemote) {
    candidates.push({
      id: 'openai-compatible',
      enabled: true,
      embed: async (text) => {
        const r = await openaiCompatibleEmbed(cfg.baseUrl, cfg.apiKey!, cfg.model, text, cfg.timeoutMs);
        return r[0];
      },
      embedBatch: async (texts) =>
        openaiCompatibleEmbed(cfg.baseUrl, cfg.apiKey!, cfg.model, texts, cfg.timeoutMs),
    });
  }

  // 2) Local Ark-compatible bridge on localhost:9876
  candidates.push({
    id: 'bge-local',
    enabled: true,
    embed: async (text) => {
      const r = await bgeLocalEmbed(cfg.bgeBaseUrl, [text], cfg.timeoutMs);
      return r[0];
    },
    embedBatch: async (texts) => bgeLocalEmbed(cfg.bgeBaseUrl, texts, cfg.timeoutMs),
  });

  return candidates;
}

/**
 * Single-text embed with fallback chain. Throws EmbeddingUnavailableError when
 * all providers fail.
 */
export async function embed(text: string): Promise<{ embedding: number[]; provider: string }> {
  const cfg = resolveConfig();
  const candidates = buildCandidates(cfg);
  const probed: string[] = [];
  let lastError: string | undefined;

  for (const c of candidates) {
    if (!c.enabled) continue;
    const baseUrl =
      c.id === 'openai-compatible'
        ? cfg.baseUrl
        : cfg.bgeBaseUrl;
    const model = c.id === 'openai-compatible' ? cfg.model : 'doubao-embedding-vision-251215';
    const key = cacheKey(c.id, baseUrl, model);
    const cached = getCached(key);
    if (cached && !cached.ok) {
      // Skip recently-failed candidate within TTL
      probed.push(`${c.id}(cached-fail)`);
      lastError = cached.lastError;
      continue;
    }
    probed.push(c.id);
    try {
      const embedding = await c.embed(text);
      setHealth(key, true);
      return { embedding, provider: c.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      setHealth(key, false, msg);
      // continue to next candidate
    }
  }

  throw new EmbeddingUnavailableError(probed, lastError);
}

/**
 * Batch embed with fallback chain. Single provider must serve the whole batch
 * (we do not split across providers).
 */
export async function embedBatch(
  texts: string[],
): Promise<{ embeddings: number[][]; provider: string }> {
  if (texts.length === 0) return { embeddings: [], provider: 'noop' };

  const cfg = resolveConfig();
  const candidates = buildCandidates(cfg);
  const probed: string[] = [];
  let lastError: string | undefined;

  for (const c of candidates) {
    if (!c.enabled) continue;
    const baseUrl =
      c.id === 'openai-compatible'
        ? cfg.baseUrl
        : cfg.bgeBaseUrl;
    const model = c.id === 'openai-compatible' ? cfg.model : 'doubao-embedding-vision-251215';
    const key = cacheKey(c.id, baseUrl, model);
    const cached = getCached(key);
    if (cached && !cached.ok) {
      probed.push(`${c.id}(cached-fail)`);
      lastError = cached.lastError;
      continue;
    }
    probed.push(c.id);
    try {
      const embeddings = c.embedBatch
        ? await c.embedBatch(texts)
        : await Promise.all(texts.map((t) => c.embed(t)));
      setHealth(key, true);
      return { embeddings, provider: c.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      setHealth(key, false, msg);
    }
  }

  throw new EmbeddingUnavailableError(probed, lastError);
}

/**
 * Quick health probe — used by /api/v1/search to decide lexical fallback before
 * attempting embed (returns true if any provider responded successfully within
 * the cache TTL window or in this probe).
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  try {
    await embed('health-probe');
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a description of the active provider config for debugging / API
 * meta fields. Does NOT leak the API key.
 */
export function describeEmbeddingConfig(): {
  primary: 'openai-compatible';
  primaryEndpoint: string;
  primaryModel: string;
  hasApiKey: boolean;
  bgeEndpoint: string;
} {
  const cfg = resolveConfig();
  return {
    primary: 'openai-compatible',
    primaryEndpoint: cfg.baseUrl,
    primaryModel: cfg.model,
    hasApiKey: Boolean(cfg.apiKey),
    bgeEndpoint: cfg.bgeBaseUrl,
  };
}

function readArkApiKeyFromOpenClaw(): string | null {
  const configPath = path.resolve(process.env.HOME ?? '/root', '.openclaw', 'openclaw.json');
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      models?: { providers?: Record<string, { apiKey?: string }> };
    };
    return raw.models?.providers?.['volcengine-ark']?.apiKey?.trim() || null;
  } catch {
    return null;
  }
}
