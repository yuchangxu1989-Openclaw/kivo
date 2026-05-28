/**
 * search route + embedding 不可用时返回 503 行为测试
 *
 * 验证 W2-P0-01 + FR-C04 AC5 真闭环：embedding 全部失败时 GET /api/v1/search
 * 应返回 **503 + 三段式错误体**，并把错误登记到 quality_gate_log（错误介入入口）。
 *
 * 重点：
 *   1. response.status === 503
 *   2. body.error.code === 'EMBEDDING_UNAVAILABLE'
 *   3. body.error.what / why / how 三段都不空
 *   4. body.meta.embeddingMode === 'unavailable' + recoveryActionId
 *   5. quality_gate_log INSERT 被调用，decision='embedding_unavailable'
 *
 * 注意：route 用 `err instanceof EmbeddingUnavailableError` 判别，所以必须
 * mock @/lib/semantic-search 抛出**真实的** EmbeddingUnavailableError 类
 * （从 @/lib/embedding-client 导入），不能用 fake class。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { EmbeddingUnavailableError } from '@/lib/embedding-client';

vi.mock('@/lib/semantic-search', () => ({
  embedQuery: vi.fn(),
  semanticSearchDb: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/paginated-queries', () => ({
  findEntriesByIds: vi.fn().mockReturnValue([]),
}));

// 捕获 quality_gate_log 写入：mock better-sqlite3，记录每次 prepare/run 调用。
const dbCalls: { sql: string; args: unknown[] }[] = [];
const fakeDb = {
  prepare: vi.fn().mockImplementation((sql: string) => ({
    get: (...args: unknown[]) => {
      dbCalls.push({ sql, args });
      return undefined; // dedup 查询返回空
    },
    run: (...args: unknown[]) => {
      dbCalls.push({ sql, args });
      return { changes: 1, lastInsertRowid: 0 };
    },
    all: (..._args: unknown[]) => [],
  })),
  close: vi.fn(),
};

vi.mock('better-sqlite3', () => {
  function Database(_path?: string, _opts?: unknown) {
    return fakeDb;
  }
  return {
    default: Database,
  };
});

describe('GET /api/v1/search — embedding unavailable 503 (W2-P0-01 / FR-C04 AC5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbCalls.length = 0;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('embedding 全部不可用时返回 503 + 三段式 + 写 quality_gate_log', async () => {
    const semanticMod = await import('@/lib/semantic-search');
    (semanticMod.embedQuery as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new EmbeddingUnavailableError(['openai-compatible', 'ollama', 'bge-local'], 'ECONNREFUSED'),
    );

    const { GET } = await import('@/app/api/v1/search/route');
    const req = new NextRequest('http://localhost/api/v1/search?q=keyword');
    const resp = await GET(req);

    expect(resp.status).toBe(503);
    const body = await resp.json();

    // 三段式错误体
    expect(body.error.code).toBe('EMBEDDING_UNAVAILABLE');
    expect(body.error.what).toBeTruthy();
    expect(body.error.why).toBeTruthy();
    expect(body.error.how).toBeTruthy();
    expect(body.error.how).toContain('KIVO_EMBEDDING_BASE_URL');
    expect(body.error.how).toContain('kivo init --offline');
    expect(Array.isArray(body.error.probedProviders)).toBe(true);

    // meta 字段
    expect(body.meta.embeddingMode).toBe('unavailable');
    expect(body.meta.recoveryActionId).toBe('recheck_embedding_provider');
    expect(typeof body.meta.primaryEndpoint).toBe('string');

    // 验证 quality_gate_log 写入（INSERT INTO quality_gate_log）
    const inserts = dbCalls.filter((c) => /INSERT\s+INTO\s+quality_gate_log/i.test(c.sql));
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    // 第 4 个绑定参数是 decision（INSERT 列顺序见 route.ts logEmbeddingErrorIntervention）
    expect(inserts[0].args[3]).toBe('embedding_unavailable');
  });

  it('embedding 正常时返回 200 + meta.embeddingMode=semantic', async () => {
    const semanticMod = await import('@/lib/semantic-search');
    (semanticMod.embedQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([0.1, 0.2]);
    (semanticMod.semanticSearchDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const { GET } = await import('@/app/api/v1/search/route');
    const req = new NextRequest('http://localhost/api/v1/search?q=keyword');
    const resp = await GET(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.meta.embeddingMode).toBe('semantic');
  });

  it('q 缺失或空字符串返回 400 BAD_REQUEST', async () => {
    const { GET } = await import('@/app/api/v1/search/route');
    const req = new NextRequest('http://localhost/api/v1/search?q=');
    const resp = await GET(req);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.code).toBe('BAD_REQUEST');
  });
});
