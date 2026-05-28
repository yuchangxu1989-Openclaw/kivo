/**
 * embedding-client.ts — fallback chain 单元测试
 *
 * 验证 W2-P0-01: embedding 默认开箱可用 / 三层 fallback 链路 / 全部失败抛
 * EmbeddingUnavailableError（让 search route 能优雅降级到 lexical）。
 *
 * Mock fetch，覆盖以下场景：
 *  1) 远程 OpenAI 兼容 endpoint 命中（用户配了 KIVO_EMBEDDING_BASE_URL + KEY）
 *  2) 远程失败 → 本机 ollama 命中
 *  3) 远程失败 + ollama 失败 → 本机 BGE 命中
 *  4) 三家全部失败 → 抛 EmbeddingUnavailableError，错误信息含恢复指引
 *  5) 健康缓存：连续失败的 provider 在 TTL 内被跳过
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 重要：每个用例都需要 reset module + env，否则 resolveConfig 缓存会污染
const ORIG_ENV = { ...process.env };

async function loadModule() {
  vi.resetModules();
  return await import('@/lib/embedding-client');
}

function setEnv(overrides: Record<string, string | undefined>) {
  for (const k of Object.keys(overrides)) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
}

describe('embedding-client — fallback chain (W2-P0-01)', () => {
  beforeEach(() => {
    // 清空所有 KIVO_* env，避免外部环境串扰
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('KIVO_')) delete process.env[k];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // 还原原始 env
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('KIVO_') && !(k in ORIG_ENV)) delete process.env[k];
    }
    for (const k of Object.keys(ORIG_ENV)) {
      process.env[k] = ORIG_ENV[k] as string;
    }
  });

  it('优先走远程 OpenAI 兼容 endpoint（配置了 BASE_URL + API_KEY）', async () => {
    setEnv({
      KIVO_EMBEDDING_BASE_URL: 'https://example.com',
      KIVO_EMBEDDING_API_KEY: 'sk-test',
      KIVO_EMBEDDING_MODEL: 'bge-m3',
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const mod = await loadModule();
    mod._resetEmbeddingHealthCache();
    const out = await mod.embed('hello');
    expect(out.provider).toBe('openai-compatible');
    expect(out.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe('https://example.com/v1/embeddings');
  });

  it('远程失败 → 本机 ollama 命中', async () => {
    setEnv({
      KIVO_EMBEDDING_BASE_URL: 'https://broken.example.com',
      KIVO_EMBEDDING_API_KEY: 'sk-test',
    });
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('broken.example.com')) {
        return new Response('upstream error', { status: 502 });
      }
      if (url.includes('11434/api/embed')) {
        return new Response(
          JSON.stringify({ embeddings: [[0.4, 0.5, 0.6]] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not mocked', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await loadModule();
    mod._resetEmbeddingHealthCache();
    const out = await mod.embed('hi');
    expect(out.provider).toBe('ollama');
    expect(out.embedding).toEqual([0.4, 0.5, 0.6]);
  });

  it('远程 + ollama 失败 → 本机 BGE 命中', async () => {
    setEnv({
      KIVO_EMBEDDING_BASE_URL: 'https://broken.example.com',
      KIVO_EMBEDDING_API_KEY: 'sk-test',
    });
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('broken.example.com')) {
        return new Response('upstream error', { status: 502 });
      }
      if (url.includes('11434')) {
        // ollama 不在
        throw new Error('ECONNREFUSED');
      }
      if (url.includes('9876/embed')) {
        return new Response(
          JSON.stringify({ embeddings: [[0.7, 0.8, 0.9]] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not mocked', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await loadModule();
    mod._resetEmbeddingHealthCache();
    const out = await mod.embed('hi');
    expect(out.provider).toBe('bge-local');
    expect(out.embedding).toEqual([0.7, 0.8, 0.9]);
  });

  it('三家全部失败 → 抛 EmbeddingUnavailableError 含恢复指引', async () => {
    // 默认 env：不配置远程，直接走 ollama → bge-local 都失败
    const fetchMock = vi.fn().mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await loadModule();
    mod._resetEmbeddingHealthCache();
    await expect(mod.embed('hi')).rejects.toMatchObject({
      name: 'EmbeddingUnavailableError',
    });
    try {
      await mod.embed('hi-again');
    } catch (e) {
      const err = e as Error;
      // 错误信息必须含 ollama 推荐 + KIVO_EMBEDDING_BASE_URL 提示
      expect(err.message).toContain('ollama');
      expect(err.message).toContain('KIVO_EMBEDDING_BASE_URL');
    }
  });

  it('健康缓存：失败的 provider 在 TTL 内被跳过', async () => {
    setEnv({
      KIVO_EMBEDDING_BASE_URL: 'https://example.com',
      KIVO_EMBEDDING_API_KEY: 'sk-test',
    });
    let remoteCalls = 0;
    let ollamaCalls = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('example.com')) {
        remoteCalls += 1;
        return new Response('boom', { status: 500 });
      }
      if (url.includes('11434')) {
        ollamaCalls += 1;
        return new Response(
          JSON.stringify({ embeddings: [[1, 2, 3]] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not mocked', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await loadModule();
    mod._resetEmbeddingHealthCache();
    await mod.embed('one');
    await mod.embed('two');
    await mod.embed('three');
    // remote 应该只被实际探测过 1 次（首次失败后 cache 命中跳过）
    expect(remoteCalls).toBe(1);
    expect(ollamaCalls).toBe(3);
  });

  it('isEmbeddingAvailable 在 ollama 命中时返回 true', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('11434')) {
        return new Response(
          JSON.stringify({ embeddings: [[0.1]] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error('not mocked');
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await loadModule();
    mod._resetEmbeddingHealthCache();
    expect(await mod.isEmbeddingAvailable()).toBe(true);
  });

  it('isEmbeddingAvailable 在三家都失败时返回 false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const mod = await loadModule();
    mod._resetEmbeddingHealthCache();
    expect(await mod.isEmbeddingAvailable()).toBe(false);
  });

  it('describeEmbeddingConfig 不泄漏 API key', async () => {
    setEnv({
      KIVO_EMBEDDING_BASE_URL: 'https://example.com',
      KIVO_EMBEDDING_API_KEY: 'sk-secret',
    });
    const mod = await loadModule();
    const cfg = mod.describeEmbeddingConfig();
    expect(cfg.primary).toBe('openai-compatible');
    expect(cfg.hasApiKey).toBe(true);
    // 字段里不应该出现明文 key
    expect(JSON.stringify(cfg)).not.toContain('sk-secret');
  });

  it('EmbeddingUnavailableError 是三段式：发生了什么 / 可能原因 / 恢复动作（FR-Z04 AC1 / FR-C04 AC5）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const mod = await loadModule();
    mod._resetEmbeddingHealthCache();
    let caught: unknown;
    try {
      await mod.embed('hi');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(mod.EmbeddingUnavailableError);
    const err = caught as InstanceType<typeof mod.EmbeddingUnavailableError>;
    expect(err.what).toMatch(/embedding 服务全部不可用/);
    expect(err.why).toMatch(/常见原因/);
    expect(err.how).toMatch(/KIVO_EMBEDDING_BASE_URL/);
    expect(err.how).toMatch(/kivo init --offline/);
    expect(err.message).toContain(err.what);
    expect(err.message).toContain(err.why);
    expect(err.message).toContain(err.how);
  });

  it('embeddingUnavailableErrorPayload 输出 search 4xx body 标准结构', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const mod = await loadModule();
    mod._resetEmbeddingHealthCache();
    let err: InstanceType<typeof mod.EmbeddingUnavailableError> | undefined;
    try {
      await mod.embed('hi');
    } catch (e) {
      err = e as InstanceType<typeof mod.EmbeddingUnavailableError>;
    }
    expect(err).toBeDefined();
    const payload = mod.embeddingUnavailableErrorPayload(err!);
    expect(payload.code).toBe('EMBEDDING_UNAVAILABLE');
    expect(payload.what).toBe(err!.what);
    expect(payload.why).toBe(err!.why);
    expect(payload.how).toBe(err!.how);
    expect(Array.isArray(payload.probedProviders)).toBe(true);
    expect(payload.probedProviders.length).toBeGreaterThan(0);
  });
});
