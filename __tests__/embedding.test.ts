import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalEmbedding } from '../src/embedding/local-embedding.js';
import { EmbeddingCache } from '../src/embedding/embedding-cache.js';
import { OpenAIEmbedding } from '../src/embedding/openai-embedding.js';
import type { EmbeddingProvider } from '../src/embedding/embedding-provider.js';

describe('LocalEmbedding', () => {
  let provider: LocalEmbedding;

  beforeEach(() => {
    provider = new LocalEmbedding();
  });

  it('embed returns vector of correct dimensions', async () => {
    const vec = await provider.embed('hello world');
    expect(vec).toHaveLength(384);
  });

  it('embedBatch returns correct number of vectors', async () => {
    const vecs = await provider.embedBatch(['hello', 'world', 'test']);
    expect(vecs).toHaveLength(3);
    vecs.forEach(v => expect(v).toHaveLength(384));
  });

  it('dimensions() returns 384', () => {
    expect(provider.dimensions()).toBe(384);
  });

  it('modelId() returns local-bow', () => {
    expect(provider.modelId()).toBe('local-bow');
  });

  it('custom dimensions', async () => {
    const p = new LocalEmbedding(128);
    expect(p.dimensions()).toBe(128);
    const vec = await p.embed('test');
    expect(vec).toHaveLength(128);
  });

  it('same text produces same vector', async () => {
    const v1 = await provider.embed('deterministic');
    const v2 = await provider.embed('deterministic');
    expect(v1).toEqual(v2);
  });

  it('different text produces different vectors', async () => {
    const v1 = await provider.embed('hello');
    const v2 = await provider.embed('completely different text');
    expect(v1).not.toEqual(v2);
  });

  it('vectors are L2 normalized', async () => {
    const vec = await provider.embed('normalize me');
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it('empty text returns zero vector', async () => {
    const vec = await provider.embed('');
    // all zeros (no tokens → no accumulation → norm=0 → stays zero)
    expect(vec.every(v => v === 0)).toBe(true);
  });
});

describe('EmbeddingCache', () => {
  let mockProvider: EmbeddingProvider;
  let cache: EmbeddingCache;

  beforeEach(() => {
    mockProvider = {
      embed: vi.fn(async (text: string) => Array(4).fill(text.length / 10)),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(t => Array(4).fill(t.length / 10))),
      dimensions: () => 4,
      modelId: () => 'mock',
    };
    cache = new EmbeddingCache(mockProvider, 3);
  });

  it('delegates to provider on cache miss', async () => {
    await cache.embed('hello');
    expect(mockProvider.embed).toHaveBeenCalledWith('hello');
  });

  it('returns cached result on hit', async () => {
    await cache.embed('hello');
    await cache.embed('hello');
    expect(mockProvider.embed).toHaveBeenCalledTimes(1);
  });

  it('stats tracks hits and misses', async () => {
    await cache.embed('a');
    await cache.embed('b');
    await cache.embed('a'); // hit
    const s = cache.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(2);
    expect(s.size).toBe(2);
    expect(s.maxSize).toBe(3);
  });

  it('LRU eviction when maxSize exceeded', async () => {
    await cache.embed('a');
    await cache.embed('b');
    await cache.embed('c');
    // cache full: [a, b, c]
    await cache.embed('d');
    // 'a' evicted: [b, c, d]
    const s = cache.stats();
    expect(s.size).toBe(3);

    // 'a' should miss again
    await cache.embed('a');
    expect(mockProvider.embed).toHaveBeenCalledTimes(5); // a,b,c,d,a
  });

  it('LRU access refreshes position', async () => {
    await cache.embed('a');
    await cache.embed('b');
    await cache.embed('c');
    // access 'a' to refresh it
    await cache.embed('a'); // hit, moves 'a' to end
    // now order: [b, c, a]
    await cache.embed('d'); // evicts 'b'
    await cache.embed('b'); // miss (was evicted)
    expect(mockProvider.embed).toHaveBeenCalledTimes(5); // a,b,c,d,b
  });

  it('embedBatch uses cache for known texts', async () => {
    await cache.embed('x');
    await cache.embedBatch(['x', 'y']);
    // 'x' from cache, 'y' from provider batch
    expect(mockProvider.embedBatch).toHaveBeenCalledWith(['y']);
  });

  it('clear resets cache and stats', async () => {
    await cache.embed('a');
    cache.clear();
    const s = cache.stats();
    expect(s.size).toBe(0);
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
  });

  it('dimensions and modelId delegate to provider', () => {
    expect(cache.dimensions()).toBe(4);
    expect(cache.modelId()).toBe('mock');
  });
});

describe('OpenAIEmbedding', () => {
  let provider: OpenAIEmbedding;

  beforeEach(() => {
    provider = new OpenAIEmbedding({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:9999/v1',
    });
    vi.restoreAllMocks();
  });

  it('dimensions defaults to 1536 for text-embedding-3-small', () => {
    expect(provider.dimensions()).toBe(1536);
  });

  it('modelId returns configured model', () => {
    expect(provider.modelId()).toBe('text-embedding-3-small');
  });

  it('custom model', () => {
    const p = new OpenAIEmbedding({
      apiKey: 'k',
      model: 'text-embedding-3-large',
    });
    expect(p.modelId()).toBe('text-embedding-3-large');
    expect(p.dimensions()).toBe(3072);
  });

  it('embed sends correct request format', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: Array(1536).fill(0.1), index: 0 }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await provider.embed('test text');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:9999/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-key',
        },
        body: JSON.stringify({ input: ['test text'], model: 'text-embedding-3-small' }),
      }),
    );
    expect(result).toHaveLength(1536);
  });

  it('embedBatch splits into chunks of maxBatchSize', async () => {
    const smallBatchProvider = new OpenAIEmbedding({
      apiKey: 'k',
      baseUrl: 'http://localhost:9999/v1',
      maxBatchSize: 2,
    });

    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: { body: string }) => {
      const { input } = JSON.parse(opts.body) as { input: string[] };
      return {
        ok: true,
        json: async () => ({
          data: input.map((_, i) => ({ embedding: [0.1 * (i + 1), 0.2 * (i + 1)], index: i })),
        }),
      };
    });
    vi.stubGlobal('fetch', mockFetch);

    const texts = ['a', 'b', 'c', 'd', 'e'];
    const results = await smallBatchProvider.embedBatch(texts);

    // 5 texts / batch 2 = 3 API calls (2+2+1)
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(5);
  });

  it('retries on failure with exponential backoff', async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: Array(1536).fill(0), index: 0 }],
        }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await provider.embed('retry test');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(1536);
  });

  it('throws after max retries exhausted', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('persistent failure'));
    vi.stubGlobal('fetch', mockFetch);

    await expect(provider.embed('fail')).rejects.toThrow('persistent failure');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(provider.embed('rate')).rejects.toThrow('OpenAI embedding API error 429: rate limited');
  });

  it('handles out-of-order response indices', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { embedding: [0.9], index: 1 },
          { embedding: [0.1], index: 0 },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const results = await provider.embedBatch(['first', 'second']);
    expect(results[0]).toEqual([0.1]);
    expect(results[1]).toEqual([0.9]);
  });

  it('embedBatch returns empty array for empty input', async () => {
    const results = await provider.embedBatch([]);
    expect(results).toEqual([]);
  });
});
