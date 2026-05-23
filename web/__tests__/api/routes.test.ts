/**
 * KIVO Web API Integration Tests
 *
 * Tests all core v1 API route handlers by importing them directly
 * and constructing NextRequest objects — no dev server needed.
 *
 * Routes covered:
 *   1.  GET  /api/v1/knowledge        — knowledge entry list
 *   2.  GET  /api/v1/knowledge/:id    — knowledge entry detail
 *   3.  GET  /api/v1/graph            — knowledge graph snapshot
 *   4.  GET  /api/v1/imports          — import job list
 *   5.  POST /api/v1/imports          — create import job
 *   6.  GET  /api/v1/intents          — intent list
 *   7.  POST /api/v1/intents          — create intent
 *   8.  GET  /api/v1/conflicts        — conflict list
 *   9.  GET  /api/v1/activity         — activity feed
 *   10. GET  /api/v1/analytics/coverage    — coverage analytics
 *   11. GET  /api/v1/analytics/dispatch    — dispatch analytics
 *   12. GET  /api/v1/analytics/utilization — utilization analytics
 *   13. POST /api/v1/conflicts/:id/resolve — conflict resolution
 *   14. GET  /api/v1/dashboard/summary     — dashboard summary
 *   15. GET+POST+PUT+DELETE /api/v1/dictionary — dictionary CRUD
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Helpers ────────────────────────────────────────────────────────────────

const BASE = 'http://localhost:3000';

function makeGet(path: string): NextRequest {
  return new NextRequest(new URL(path, BASE));
}

function makePost(path: string, body: unknown): NextRequest {
  return new NextRequest(new URL(path, BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makePut(path: string, body: unknown): NextRequest {
  return new NextRequest(new URL(path, BASE), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDelete(path: string): NextRequest {
  return new NextRequest(new URL(path, BASE), { method: 'DELETE' });
}

async function json<T = unknown>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

// ─── 1. GET /api/v1/knowledge ───────────────────────────────────────────────

describe('GET /api/v1/knowledge', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/knowledge/route');
    GET = mod.GET;
  });

  it('returns paginated knowledge entries', async () => {
    const res = await GET(makeGet('/api/v1/knowledge'));
    expect(res.status).toBe(200);

    const body = await json<{ data: unknown[]; meta: { total: number; page: number; pageSize: number } }>(res);
    expect(body.data).toBeInstanceOf(Array);
    expect(body.meta).toBeDefined();
    expect(body.meta.page).toBe(1);
    expect(body.meta.pageSize).toBeGreaterThan(0);
    expect(body.meta.total).toBeGreaterThanOrEqual(0);
  });

  it('rejects invalid type parameter', async () => {
    const res = await GET(makeGet('/api/v1/knowledge?type=INVALID_TYPE'));
    expect(res.status).toBe(400);

    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects invalid status parameter', async () => {
    const res = await GET(makeGet('/api/v1/knowledge?status=BOGUS'));
    expect(res.status).toBe(400);

    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('BAD_REQUEST');
  });
});

// ─── 2. GET /api/v1/knowledge/:id ───────────────────────────────────────────

describe('GET /api/v1/knowledge/:id', () => {
  let GET: (req: NextRequest, ctx: { params: { id: string } }) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/knowledge/[id]/route');
    GET = mod.GET;
  });

  it('returns entry detail for a valid id', async () => {
    // ke-001 is seeded by kivo-engine
    const res = await GET(makeGet('/api/v1/knowledge/ke-001'), { params: { id: 'ke-001' } });
    expect(res.status).toBe(200);

    const body = await json<{ data: { id: string; title: string; relations: unknown[]; versions: unknown[] } }>(res);
    expect(body.data.id).toBe('ke-001');
    expect(body.data.title).toBeTruthy();
    expect(body.data.relations).toBeInstanceOf(Array);
    expect(body.data.versions).toBeInstanceOf(Array);
  });

  it('returns 404 for non-existent id', async () => {
    const res = await GET(makeGet('/api/v1/knowledge/does-not-exist'), { params: { id: 'does-not-exist' } });
    expect(res.status).toBe(404);

    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ─── 3. GET /api/v1/graph ───────────────────────────────────────────────────

describe('GET /api/v1/graph', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/graph/route');
    GET = mod.GET;
  });

  it('returns graph snapshot with nodes and edges', async () => {
    const res = await GET(makeGet('/api/v1/graph'));
    expect(res.status).toBe(200);

    const body = await json<{ data: { nodes: unknown[]; edges: unknown[]; updatedAt: string } }>(res);
    expect(body.data.nodes).toBeInstanceOf(Array);
    expect(body.data.edges).toBeInstanceOf(Array);
    expect(body.data.updatedAt).toBeTruthy();
  });

  it('filters by type parameter', async () => {
    const res = await GET(makeGet('/api/v1/graph?type=decision'));
    expect(res.status).toBe(200);

    const body = await json<{ data: { nodes: Array<{ type: string }> } }>(res);
    // All returned nodes should be of type 'decision'
    for (const node of body.data.nodes) {
      expect(node.type).toBe('decision');
    }
  });
});

// ─── 4. GET /api/v1/imports ─────────────────────────────────────────────────

describe('GET /api/v1/imports', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/imports/route');
    GET = mod.GET;
  });

  it('returns import job list (initially empty or seeded)', async () => {
    const res = await GET(makeGet('/api/v1/imports'));
    expect(res.status).toBe(200);

    const body = await json<{ data: unknown[] }>(res);
    expect(body.data).toBeInstanceOf(Array);
  });

  it('returns 404 for non-existent import job id', async () => {
    const res = await GET(makeGet('/api/v1/imports?id=nonexistent-job'));
    expect(res.status).toBe(404);

    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ─── 5. POST /api/v1/imports ────────────────────────────────────────────────

describe('POST /api/v1/imports', () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/imports/route');
    POST = mod.POST;
  });

  it('creates an import job with valid payload', async () => {
    const res = await POST(
      makePost('/api/v1/imports', {
        fileName: 'test-doc.md',
        fileType: 'md',
        fileSizeMb: 2.5,
        content: '# Test Document\n\nThis is a test document with enough content for extraction.\n\nIt contains multiple sections to generate candidates.',
      }),
    );
    expect(res.status).toBe(201);

    const body = await json<{ data: { id: string; fileName: string; candidates: unknown[] } }>(res);
    expect(body.data.id).toBeTruthy();
    expect(body.data.fileName).toBe('test-doc.md');
    expect(body.data.candidates).toBeInstanceOf(Array);
    expect(body.data.candidates.length).toBeGreaterThan(0);
  });

  it('rejects missing fileName', async () => {
    const res = await POST(
      makePost('/api/v1/imports', { fileType: 'md', fileSizeMb: 1 }),
    );
    expect(res.status).toBe(400);

    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects unsupported file type', async () => {
    const res = await POST(
      makePost('/api/v1/imports', { fileName: 'test.pdf', fileType: 'pdf', fileSizeMb: 1 }),
    );
    expect(res.status).toBe(400);
  });
});

// ─── 6. GET /api/v1/intents ─────────────────────────────────────────────────

describe('GET /api/v1/intents', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/intents/route');
    GET = mod.GET;
  });

  it('returns intent data', async () => {
    const res = await GET(makeGet('/api/v1/intents'));
    expect(res.status).toBe(200);

    const body = await json<{ data: { items: unknown[] } }>(res);
    expect(body.data).toBeDefined();
    expect(body.data.items).toBeInstanceOf(Array);
  });

  it('returns 404 for non-existent intent id', async () => {
    const res = await GET(makeGet('/api/v1/intents?id=nonexistent-intent'));
    expect(res.status).toBe(404);

    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ─── 7. POST /api/v1/intents ────────────────────────────────────────────────

describe('POST /api/v1/intents', () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/intents/route');
    POST = mod.POST;
  });

  it('creates an intent with valid payload', async () => {
    const res = await POST(
      makePost('/api/v1/intents', {
        name: 'test-intent',
        description: 'A test intent for integration testing',
        positives: ['positive example 1'],
        negatives: ['negative example 1'],
        relatedEntryCount: 3,
      }),
    );
    expect(res.status).toBe(201);

    const body = await json<{ data: { items: Array<{ name: string }> } }>(res);
    expect(body.data).toBeDefined();
  });

  it('rejects missing name', async () => {
    const res = await POST(
      makePost('/api/v1/intents', { description: 'no name provided' }),
    );
    expect(res.status).toBe(400);

    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects missing description', async () => {
    const res = await POST(
      makePost('/api/v1/intents', { name: 'intent-no-desc' }),
    );
    expect(res.status).toBe(400);
  });
});

// ─── 8. GET /api/v1/conflicts ───────────────────────────────────────────────

describe('GET /api/v1/conflicts', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/conflicts/route');
    GET = mod.GET;
  });

  it('returns paginated conflict list', async () => {
    const res = await GET(makeGet('/api/v1/conflicts'));
    expect(res.status).toBe(200);

    const body = await json<{ data: unknown[]; meta: { total: number; page: number; pageSize: number } }>(res);
    expect(body.data).toBeInstanceOf(Array);
    expect(body.meta).toBeDefined();
    expect(body.meta.page).toBe(1);
    expect(body.meta.total).toBeGreaterThanOrEqual(0);
  });

  it('filters by status=resolved', async () => {
    const res = await GET(makeGet('/api/v1/conflicts?status=resolved'));
    expect(res.status).toBe(200);

    const body = await json<{ data: Array<{ status: string }> }>(res);
    for (const item of body.data) {
      expect(item.status).toBe('resolved');
    }
  });

  it('supports status=all to return everything', async () => {
    const res = await GET(makeGet('/api/v1/conflicts?status=all'));
    expect(res.status).toBe(200);

    const body = await json<{ data: unknown[]; meta: { total: number } }>(res);
    expect(body.data).toBeInstanceOf(Array);
    expect(body.meta.total).toBeGreaterThanOrEqual(0);
  });
});

// ─── 9. GET /api/v1/activity ────────────────────────────────────────────────

describe('GET /api/v1/activity', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/activity/route');
    GET = mod.GET;
  });

  it('returns activity feed with filters and items', async () => {
    const res = await GET(makeGet('/api/v1/activity'));
    expect(res.status).toBe(200);

    const body = await json<{ data: { filters: unknown[]; items: unknown[] } }>(res);
    expect(body.data.filters).toBeInstanceOf(Array);
    expect(body.data.items).toBeInstanceOf(Array);
  });

  it('accepts type filter parameter', async () => {
    const res = await GET(makeGet('/api/v1/activity?type=knowledge'));
    expect(res.status).toBe(200);

    const body = await json<{ data: { items: unknown[] } }>(res);
    expect(body.data.items).toBeInstanceOf(Array);
  });

  it('accepts since parameter for incremental fetch', async () => {
    const res = await GET(makeGet('/api/v1/activity?since=evt-999'));
    expect(res.status).toBe(200);

    const body = await json<{ data: { items: unknown[] } }>(res);
    expect(body.data.items).toBeInstanceOf(Array);
  });
});

// ─── 10. GET /api/v1/analytics/coverage ─────────────────────────────────────

describe('GET /api/v1/analytics/coverage', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/analytics/coverage/route');
    GET = mod.GET;
  });

  it('returns coverage analytics data', async () => {
    const res = await GET(makeGet('/api/v1/analytics/coverage'));
    expect(res.status).toBe(200);

    const body = await json<{ data: { domains: Array<{ name: string; count: number; hitRate: number }> } }>(res);
    expect(body.data).toBeDefined();
    expect(body.data.domains).toBeInstanceOf(Array);
  });
});

// ─── 11. GET /api/v1/analytics/dispatch ─────────────────────────────────────

describe('GET /api/v1/analytics/dispatch', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/analytics/dispatch/route');
    GET = mod.GET;
  });

  it('returns dispatch analytics data', async () => {
    const res = await GET(makeGet('/api/v1/analytics/dispatch'));
    expect(res.status).toBe(200);

    const body = await json<{ data: { activeRules: unknown[]; failedRules: unknown[] } }>(res);
    expect(body.data).toBeDefined();
    expect(body.data.activeRules).toBeInstanceOf(Array);
    expect(body.data.failedRules).toBeInstanceOf(Array);
  });
});

// ─── 12. GET /api/v1/analytics/utilization ──────────────────────────────────

describe('GET /api/v1/analytics/utilization', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/analytics/utilization/route');
    GET = mod.GET;
  });

  it('returns utilization analytics data', async () => {
    const res = await GET(makeGet('/api/v1/analytics/utilization'));
    expect(res.status).toBe(200);

    const body = await json<{ data: { topUsed: unknown[]; sleepingKnowledge: unknown[]; missedQueries: unknown[] } }>(res);
    expect(body.data).toBeDefined();
    expect(body.data.topUsed).toBeInstanceOf(Array);
    expect(body.data.missedQueries).toBeInstanceOf(Array);
  });
});

// ─── 13. POST /api/v1/conflicts/:id/resolve ─────────────────────────────────

describe('POST /api/v1/conflicts/:id/resolve', () => {
  let POST: (req: NextRequest, ctx: { params: { id: string } }) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/conflicts/[id]/resolve/route');
    POST = mod.POST;
  });

  it('resolves a conflict with newer-wins strategy', async () => {
    const res = await POST(
      makePost('/api/v1/conflicts/conflict-001/resolve', {
        strategy: 'newer-wins',
        expectedVersion: 1,
        requestId: 'req-test-001',
      }),
      { params: { id: 'conflict-001' } },
    );
    // 200 on success, or 404 if already resolved in prior test run
    expect([200, 404]).toContain(res.status);

    if (res.status === 200) {
      const body = await json<{ data: { id: string; status: string }; meta: { version: number; requestId: string } }>(res);
      expect(body.data.id).toBe('conflict-001');
      expect(body.meta.requestId).toBe('req-test-001');
    }
  });

  it('rejects missing strategy', async () => {
    const res = await POST(
      makePost('/api/v1/conflicts/conflict-002/resolve', {
        expectedVersion: 1,
        requestId: 'req-test-002',
      }),
      { params: { id: 'conflict-002' } },
    );
    expect(res.status).toBe(400);

    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects invalid strategy value', async () => {
    const res = await POST(
      makePost('/api/v1/conflicts/conflict-002/resolve', {
        strategy: 'invalid-strategy',
        expectedVersion: 1,
        requestId: 'req-test-003',
      }),
      { params: { id: 'conflict-002' } },
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing expectedVersion', async () => {
    const res = await POST(
      makePost('/api/v1/conflicts/conflict-002/resolve', {
        strategy: 'newer-wins',
        requestId: 'req-test-004',
      }),
      { params: { id: 'conflict-002' } },
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing requestId', async () => {
    const res = await POST(
      makePost('/api/v1/conflicts/conflict-002/resolve', {
        strategy: 'newer-wins',
        expectedVersion: 1,
      }),
      { params: { id: 'conflict-002' } },
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent conflict', async () => {
    const res = await POST(
      makePost('/api/v1/conflicts/does-not-exist/resolve', {
        strategy: 'newer-wins',
        expectedVersion: 1,
        requestId: 'req-test-005',
      }),
      { params: { id: 'does-not-exist' } },
    );
    expect(res.status).toBe(404);
  });
});

// ─── 14. GET /api/v1/dashboard/summary ──────────────────────────────────────

describe('GET /api/v1/dashboard/summary', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/dashboard/summary/route');
    GET = mod.GET;
  });

  it('returns dashboard summary with all expected fields', async () => {
    const res = await GET(makeGet('/api/v1/dashboard/summary'));
    expect(res.status).toBe(200);

    const body = await json<{
      data: {
        totalEntries: number;
        byType: Record<string, number>;
        byStatus: Record<string, number>;
        health: { pendingCount: number; unresolvedConflicts: number };
        nextAction: { title: string; description: string; href: string; tone: string };
        trends: Record<string, unknown>;
      };
    }>(res);

    expect(typeof body.data.totalEntries).toBe('number');
    expect(body.data.byType).toBeDefined();
    expect(body.data.byStatus).toBeDefined();
    expect(body.data.health).toBeDefined();
    expect(typeof body.data.health.pendingCount).toBe('number');
    expect(typeof body.data.health.unresolvedConflicts).toBe('number');
    expect(body.data.nextAction).toBeDefined();
    expect(body.data.nextAction.title).toBeTruthy();
    expect(body.data.trends).toBeDefined();
  });

  it('returns valid trend data structure', async () => {
    const res = await GET(makeGet('/api/v1/dashboard/summary'));
    expect(res.status).toBe(200);

    const body = await json<{
      data: {
        trends: {
          totalEntries: { percent: number; direction: string };
          pendingCount: { percent: number; direction: string };
        };
      };
    }>(res);

    expect(typeof body.data.trends.totalEntries.percent).toBe('number');
    expect(['up', 'down', 'flat']).toContain(body.data.trends.totalEntries.direction);
  });
});

// ─── 15. /api/v1/dictionary (GET, POST, PUT, DELETE) ────────────────────────

describe('/api/v1/dictionary', () => {
  let GET: (req: NextRequest) => Promise<Response>;
  let POST: (req: NextRequest) => Promise<Response>;
  let PUT: (req: NextRequest) => Promise<Response>;
  let DELETE: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/dictionary/route');
    GET = mod.GET;
    POST = mod.POST;
    PUT = mod.PUT;
    DELETE = mod.DELETE;
  });

  it('GET returns dictionary data', async () => {
    const res = await GET(makeGet('/api/v1/dictionary'));
    expect(res.status).toBe(200);

    const body = await json<{ data: { entries: unknown[]; total: number } }>(res);
    expect(body.data).toBeDefined();
    expect(body.data.entries).toBeInstanceOf(Array);
  });

  it('POST creates a new dictionary entry', async () => {
    const res = await POST(
      makePost('/api/v1/dictionary', {
        term: 'test-term-vitest',
        definition: 'A term created by vitest integration test',
      }),
    );
    expect(res.status).toBe(201);

    const body = await json<{ data: { entries: Array<{ term: string }> } }>(res);
    expect(body.data.entries.some((e) => e.term === 'test-term-vitest')).toBe(true);
  });

  it('POST rejects missing term', async () => {
    const res = await POST(
      makePost('/api/v1/dictionary', { definition: 'no term provided' }),
    );
    expect(res.status).toBe(400);

    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('POST rejects missing definition', async () => {
    const res = await POST(
      makePost('/api/v1/dictionary', { term: 'orphan-term' }),
    );
    expect(res.status).toBe(400);
  });

  it('PUT rejects missing id', async () => {
    const res = await PUT(
      makePut('/api/v1/dictionary', { term: 'x', definition: 'y' }),
    );
    expect(res.status).toBe(400);
  });

  it('PUT returns 404 for non-existent entry', async () => {
    const res = await PUT(
      makePut('/api/v1/dictionary', { id: 'nonexistent-id', term: 'x', definition: 'y' }),
    );
    expect(res.status).toBe(404);
  });

  it('DELETE rejects missing id', async () => {
    const res = await DELETE(makeDelete('/api/v1/dictionary'));
    expect(res.status).toBe(400);
  });

  it('DELETE returns 404 for non-existent entry', async () => {
    const res = await DELETE(makeDelete('/api/v1/dictionary?id=nonexistent-id'));
    expect(res.status).toBe(404);
  });
});
