import { describe, it, expect, vi } from 'vitest';
import { WebFetchAdapter, extractUrls, extractTextFromHtml } from '../src/research/web-fetch-adapter.js';
import type { ResearchStep, ResearchTask } from '../src/research/research-task-types.js';

// ── helpers ──────────────────────────────────────────────────────────

function makeStep(overrides: Partial<ResearchStep> = {}): ResearchStep {
  return {
    id: 'step-1',
    method: 'web_search',
    query: 'https://example.com',
    rationale: 'test',
    ...overrides,
  };
}

function makeTask(overrides: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: 'task-1',
    gapId: 'gap-1',
    gapType: 'missing_topic',
    title: 'Test Task',
    objective: 'test',
    scope: { topic: 'test', boundaries: [], acquisitionMethods: ['web_search'] },
    expectedKnowledgeTypes: ['fact'],
    strategy: { steps: [], searchQueries: [] },
    completionCriteria: [],
    budget: { maxDurationMs: 60_000, maxApiCalls: 10 },
    priority: 'medium',
    impactScore: 0.5,
    urgencyScore: 0.5,
    blocking: false,
    createdAt: new Date(),
    ...overrides,
  };
}

function mockFetch(body: string, contentType = 'text/html', ok = true): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok,
    headers: new Map([['content-type', contentType]]) as unknown as Headers,
    text: () => Promise.resolve(body),
  }) as unknown as typeof globalThis.fetch;
}

// ── extractUrls ─────────────────────────────────────────────────────

describe('extractUrls', () => {
  it('extracts single URL', () => {
    expect(extractUrls('https://example.com/page')).toEqual(['https://example.com/page']);
  });

  it('extracts multiple URLs', () => {
    const result = extractUrls('See https://a.com and http://b.com/path for details');
    expect(result).toEqual(['https://a.com', 'http://b.com/path']);
  });

  it('deduplicates URLs', () => {
    const result = extractUrls('https://a.com https://a.com');
    expect(result).toEqual(['https://a.com']);
  });

  it('returns empty for no URLs', () => {
    expect(extractUrls('no urls here')).toEqual([]);
  });

  it('returns empty for empty string', () => {
    expect(extractUrls('')).toEqual([]);
  });
});

// ── extractTextFromHtml ─────────────────────────────────────────────

describe('extractTextFromHtml', () => {
  it('strips tags and returns text', () => {
    const html = '<html><body><h1>Hello</h1><p>World</p></body></html>';
    const text = extractTextFromHtml(html);
    expect(text).toContain('Hello');
    expect(text).toContain('World');
    expect(text).not.toContain('<');
  });

  it('removes script and style blocks', () => {
    const html = '<p>Keep</p><script>alert("x")</script><style>.x{}</style><p>Also keep</p>';
    const text = extractTextFromHtml(html);
    expect(text).toContain('Keep');
    expect(text).toContain('Also keep');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('.x');
  });

  it('decodes HTML entities', () => {
    const html = '<p>A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39;</p>';
    const text = extractTextFromHtml(html);
    expect(text).toContain('A & B < C > D "E" \'F\'');
  });

  it('collapses whitespace', () => {
    const html = '<p>  lots   of   spaces  </p>';
    const text = extractTextFromHtml(html);
    expect(text).toBe('lots of spaces');
  });

  it('handles empty input', () => {
    expect(extractTextFromHtml('')).toBe('');
  });
});

// ── WebFetchAdapter ─────────────────────────────────────────────────

describe('WebFetchAdapter', () => {
  it('fetches URL and returns artifact', async () => {
    const html = '<html><body><h1>Title</h1><p>Content here</p></body></html>';
    const adapter = new WebFetchAdapter({ fetchFn: mockFetch(html) });

    const result = await adapter.execute(makeStep(), makeTask());

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].content).toContain('Title');
    expect(result.artifacts[0].content).toContain('Content here');
    expect(result.artifacts[0].reference).toBe('https://example.com');
    expect(result.apiCallsUsed).toBe(1);
  });

  it('handles plain text response', async () => {
    const adapter = new WebFetchAdapter({
      fetchFn: mockFetch('Plain text content', 'text/plain'),
    });

    const result = await adapter.execute(makeStep(), makeTask());

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].content).toBe('Plain text content');
  });

  it('returns empty for non-ok response', async () => {
    const adapter = new WebFetchAdapter({
      fetchFn: mockFetch('Not Found', 'text/html', false),
    });

    const result = await adapter.execute(makeStep(), makeTask());

    expect(result.artifacts).toHaveLength(0);
    expect(result.apiCallsUsed).toBe(1);
  });

  it('returns empty when query has no URLs', async () => {
    const adapter = new WebFetchAdapter({ fetchFn: mockFetch('') });
    const step = makeStep({ query: 'just a plain query' });

    const result = await adapter.execute(step, makeTask());

    expect(result.artifacts).toHaveLength(0);
    expect(result.apiCallsUsed).toBe(0);
  });

  it('fetches multiple URLs from query', async () => {
    const adapter = new WebFetchAdapter({
      fetchFn: mockFetch('<p>Page</p>'),
    });
    const step = makeStep({ query: 'https://a.com https://b.com https://c.com' });

    const result = await adapter.execute(step, makeTask());

    expect(result.artifacts).toHaveLength(3);
    expect(result.apiCallsUsed).toBe(3);
  });

  it('respects step.limit', async () => {
    const adapter = new WebFetchAdapter({
      fetchFn: mockFetch('<p>Page</p>'),
    });
    const step = makeStep({ query: 'https://a.com https://b.com https://c.com', limit: 1 });

    const result = await adapter.execute(step, makeTask());

    expect(result.artifacts).toHaveLength(1);
    expect(result.apiCallsUsed).toBe(1);
  });

  it('continues on individual URL failure', async () => {
    let callCount = 0;
    const fetchFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('network error');
      return Promise.resolve({
        ok: true,
        headers: new Map([['content-type', 'text/plain']]) as unknown as Headers,
        text: () => Promise.resolve('ok'),
      });
    }) as unknown as typeof globalThis.fetch;

    const adapter = new WebFetchAdapter({ fetchFn });
    const step = makeStep({ query: 'https://fail.com https://ok.com' });

    const result = await adapter.execute(step, makeTask());

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].reference).toBe('https://ok.com');
    expect(result.apiCallsUsed).toBe(2);
  });

  it('sets metadata on artifacts', async () => {
    const adapter = new WebFetchAdapter({
      fetchFn: mockFetch('<p>Hello</p>'),
    });

    const result = await adapter.execute(makeStep(), makeTask());

    expect(result.artifacts[0].metadata).toBeDefined();
    expect(result.artifacts[0].metadata!.fetchedAt).toBeDefined();
    expect(result.artifacts[0].metadata!.contentLength).toBeGreaterThan(0);
  });
});
