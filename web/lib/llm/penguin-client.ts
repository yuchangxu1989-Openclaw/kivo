/**
 * Penguin LLM Client — KIVO Wave 1 / A2
 *
 * Thin wrapper around the OpenAI-compatible chat/completions endpoint
 * served by the penguin-main provider configured in
 * /root/.openclaw/openclaw.json.
 *
 * 设计要点：
 *  - baseUrl + apiKey 必须从 openclaw.json 读取，禁止硬编码
 *  - 默认模型从 KIVO_LLM_MODEL 环境变量读，缺省 'claude-opus-4-6'
 *    （penguin-main 当前 key 对 claude-haiku-4-5 返回 403，故退回 opus）
 *  - 调用方传入 schema 提示，LLM 返回 JSON 字符串；客户端做一次容错解析：
 *    1) 直接 JSON.parse
 *    2) 提取 ```json ... ``` fenced block
 *    3) 抓首个 { ... } 子串
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CONFIG_PATH = '/root/.openclaw/openclaw.json';
const DEFAULT_MODEL = process.env.KIVO_LLM_MODEL || 'claude-opus-4-6';
const DEFAULT_PROVIDER_ID = process.env.KIVO_LLM_PROVIDER || 'penguin-main';
const DEFAULT_TIMEOUT_MS = Number(process.env.KIVO_LLM_TIMEOUT_MS || 60_000);

export class LlmClientError extends Error {
  constructor(
    public readonly code:
      | 'CONFIG_MISSING'
      | 'HTTP_ERROR'
      | 'TIMEOUT'
      | 'EMPTY_CONTENT'
      | 'PARSE_ERROR',
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'LlmClientError';
  }
}

interface ProviderRecord {
  baseUrl?: string;
  apiKey?: string;
  models?: Array<{ id?: string }>;
}

interface ResolvedProvider {
  baseUrl: string;
  apiKey: string;
  models: string[];
  providerId: string;
}

let cachedProvider: ResolvedProvider | null = null;

function resolveConfigPath(): string {
  return process.env.OPENCLAW_CONFIG_PATH || DEFAULT_CONFIG_PATH;
}

/**
 * 读取 openclaw.json 中的 penguin-main provider 配置。仅在首次调用时
 * 解析；下次复用缓存，避免每次请求重新读盘。
 */
export function getPenguinProvider(): ResolvedProvider {
  if (cachedProvider) return cachedProvider;
  const configPath = resolveConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new LlmClientError(
      'CONFIG_MISSING',
      `Cannot read openclaw.json at ${configPath}: ${(err as Error).message}`,
    );
  }
  const cfg = JSON.parse(raw) as {
    models?: { providers?: Record<string, ProviderRecord> };
  };
  const providers = cfg.models?.providers ?? {};
  const provider = providers[DEFAULT_PROVIDER_ID];
  if (!provider) {
    throw new LlmClientError(
      'CONFIG_MISSING',
      `Provider "${DEFAULT_PROVIDER_ID}" not found in ${configPath}`,
    );
  }
  if (!provider.baseUrl || !provider.apiKey) {
    throw new LlmClientError(
      'CONFIG_MISSING',
      `Provider "${DEFAULT_PROVIDER_ID}" missing baseUrl/apiKey in ${configPath}`,
    );
  }
  const baseUrl = provider.baseUrl.replace(/\/$/, '');
  const models = (provider.models ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string');
  cachedProvider = {
    baseUrl,
    apiKey: provider.apiKey,
    models,
    providerId: DEFAULT_PROVIDER_ID,
  };
  return cachedProvider;
}

/** Test hook: invalidate cache (used by integration tests if any). */
export function _resetProviderCache(): void {
  cachedProvider = null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequestOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatRawResponse {
  model: string;
  content: string;
  usage?: Record<string, unknown>;
}

/**
 * 调用 chat/completions，返回助手回复字符串。
 */
export async function chatComplete(
  messages: ChatMessage[],
  opts: ChatRequestOptions = {},
): Promise<ChatRawResponse> {
  const provider = getPenguinProvider();
  const model = opts.model || DEFAULT_MODEL;
  const url = `${provider.baseUrl}/v1/chat/completions`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.maxTokens ?? 800,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      throw new LlmClientError(
        'TIMEOUT',
        `LLM request timed out after ${timeoutMs}ms`,
      );
    }
    throw new LlmClientError('HTTP_ERROR', (err as Error).message);
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    throw new LlmClientError(
      'HTTP_ERROR',
      `LLM returned HTTP ${res.status}: ${text.slice(0, 400)}`,
      res.status,
      text,
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new LlmClientError(
      'PARSE_ERROR',
      `LLM response not valid JSON: ${(err as Error).message}`,
      res.status,
      text,
    );
  }

  const content: string | undefined = parsed?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new LlmClientError(
      'EMPTY_CONTENT',
      'LLM response missing choices[0].message.content',
      res.status,
      text,
    );
  }

  return { model, content, usage: parsed?.usage };
}

/**
 * 从 LLM 字符串响应中提取 JSON 对象。容忍：
 *   - 直接 {...}
 *   - ```json ... ``` 包围
 *   - 多行文本里嵌入第一个完整 {...}
 */
export function extractJsonObject(content: string): unknown {
  // 1) 直接尝试
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fallthrough */
  }

  // 2) 提取 ```json ... ``` 或 ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      /* fallthrough */
    }
  }

  // 3) 抓第一个平衡 {...}
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new LlmClientError(
    'PARSE_ERROR',
    `Cannot extract JSON object from LLM content: ${content.slice(0, 200)}`,
  );
}

/**
 * 一次性辅助：给定 messages，返回解析后的 JSON 对象。
 */
export async function chatJson<T = unknown>(
  messages: ChatMessage[],
  opts: ChatRequestOptions = {},
): Promise<{ data: T; raw: ChatRawResponse }> {
  const raw = await chatComplete(messages, opts);
  const data = extractJsonObject(raw.content) as T;
  return { data, raw };
}
