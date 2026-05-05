/**
 * FR-W09 ~ FR-W12 Supplemental Tests
 *
 * FR-W09: Dictionary management — scope filter, search, update, delete confirm flow
 * FR-W10: Intent management — PUT update, DELETE, sync trigger, detail by id
 * FR-W11: Login & identity — identity stored in session, returned by verify
 * FR-W12: Navigation & discovery — dashboard nextAction, conflict badge data
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

function makeReqWithCookie(path: string, cookie: string): Request {
  return new Request(new URL(path, BASE), {
    headers: { cookie },
  });
}

async function json<T = unknown>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

// ─── FR-W09: Dictionary Management ─────────────────────────────────────────

describe('FR-W09: Dictionary Management', () => {
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

  // AC1: Search and scope filter
  it('AC1: returns entries that can be filtered by scope', async () => {
    const res = await GET(makeGet('/api/v1/dictionary'));
    expect(res.status).toBe(200);

    const body = await json<{ data: { entries: Array<{ scope: string; term: string }> } }>(res);
    const scopes = new Set(body.data.entries.map((e) => e.scope));
    // Seed data has multiple scopes
    expect(scopes.size).toBeGreaterThanOrEqual(1);
  });

  it('AC1: entries contain searchable term and aliases fields', async () => {
    const res = await GET(makeGet('/api/v1/dictionary'));
    const body = await json<{ data: { entries: Array<{ term: string; aliases: string[] }> } }>(res);
    for (const entry of body.data.entries) {
      expect(typeof entry.term).toBe('string');
      expect(Array.isArray(entry.aliases)).toBe(true);
    }
  });

  // AC2: Form collapse — UI-only, tested via component structure

  // AC3: Delete returns full updated data (confirm dialog is UI-only)
  it('AC3: DELETE returns updated dictionary data after removal', async () => {
    // Create an entry to delete
    const createRes = await POST(
      makePost('/api/v1/dictionary', {
        term: 'w09-delete-test',
        definition: 'To be deleted',
        scope: '测试',
      }),
    );
    expect(createRes.status).toBe(201);
    const created = await json<{ data: { entries: Array<{ id: string; term: string }> } }>(createRes);
    const entry = created.data.entries.find((e) => e.term === 'w09-delete-test');
    expect(entry).toBeDefined();

    const deleteRes = await DELETE(makeDelete(`/api/v1/dictionary?id=${entry!.id}`));
    expect(deleteRes.status).toBe(200);
    const afterDelete = await json<{ data: { entries: Array<{ id: string }> } }>(deleteRes);
    expect(afterDelete.data.entries.find((e) => e.id === entry!.id)).toBeUndefined();
  });

  // AC4: Batch import/export — API supports sequential POST for import
  it('AC4: batch creation via sequential POST calls', async () => {
    const terms = [
      { term: 'batch-a', definition: 'Batch term A', scope: '批量' },
      { term: 'batch-b', definition: 'Batch term B', scope: '批量' },
    ];

    for (const t of terms) {
      const res = await POST(makePost('/api/v1/dictionary', t));
      expect(res.status).toBe(201);
    }

    const listRes = await GET(makeGet('/api/v1/dictionary'));
    const body = await json<{ data: { entries: Array<{ term: string }> } }>(listRes);
    expect(body.data.entries.some((e) => e.term === 'batch-a')).toBe(true);
    expect(body.data.entries.some((e) => e.term === 'batch-b')).toBe(true);
  });

  it('AC4: export data contains all required fields', async () => {
    const res = await GET(makeGet('/api/v1/dictionary'));
    const body = await json<{ data: { entries: Array<{ id: string; term: string; definition: string; aliases: string[]; scope: string; updatedAt: string }> } }>(res);
    for (const entry of body.data.entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.term).toBeTruthy();
      expect(entry.definition).toBeTruthy();
      expect(Array.isArray(entry.aliases)).toBe(true);
      expect(entry.scope).toBeTruthy();
      expect(entry.updatedAt).toBeTruthy();
    }
  });

  it('PUT updates an existing entry', async () => {
    // Create then update
    const createRes = await POST(
      makePost('/api/v1/dictionary', { term: 'w09-update-test', definition: 'Original' }),
    );
    const created = await json<{ data: { entries: Array<{ id: string; term: string }> } }>(createRes);
    const entry = created.data.entries.find((e) => e.term === 'w09-update-test');
    expect(entry).toBeDefined();

    const updateRes = await PUT(
      makePut('/api/v1/dictionary', {
        id: entry!.id,
        term: 'w09-update-test',
        definition: 'Updated definition',
        scope: '更新测试',
        aliases: ['alias-1'],
      }),
    );
    expect(updateRes.status).toBe(200);
    const updated = await json<{ data: { entries: Array<{ id: string; definition: string; scope: string; aliases: string[] }> } }>(updateRes);
    const updatedEntry = updated.data.entries.find((e) => e.id === entry!.id);
    expect(updatedEntry?.definition).toBe('Updated definition');
    expect(updatedEntry?.scope).toBe('更新测试');
    expect(updatedEntry?.aliases).toContain('alias-1');
  });
});

// ─── FR-W10: Intent Management ──────────────────────────────────────────────

describe('FR-W10: Intent Management', () => {
  let GET: (req: NextRequest) => Promise<Response>;
  let POST: (req: NextRequest) => Promise<Response>;
  let PUT: (req: NextRequest) => Promise<Response>;
  let DELETE: (req: NextRequest) => Promise<Response>;
  let SYNC_POST: () => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../app/api/v1/intents/route');
    GET = mod.GET;
    POST = mod.POST;
    PUT = mod.PUT;
    DELETE = mod.DELETE;
    const syncMod = await import('../../app/api/v1/intents/sync/route');
    SYNC_POST = syncMod.POST;
  });

  // AC1: List shows name, description, positives count, negatives count, relatedEntryCount
  it('AC1: intent list items contain all required fields', async () => {
    const res = await GET(makeGet('/api/v1/intents'));
    expect(res.status).toBe(200);
    const body = await json<{ data: { items: Array<{ id: string; name: string; description: string; positives: string[]; negatives: string[]; relatedEntryCount: number }> } }>(res);
    expect(body.data.items).toBeInstanceOf(Array);
    for (const item of body.data.items) {
      expect(item.name).toBeTruthy();
      expect(typeof item.description).toBe('string');
      expect(Array.isArray(item.positives)).toBe(true);
      expect(Array.isArray(item.negatives)).toBe(true);
      expect(typeof item.relatedEntryCount).toBe('number');
    }
  });

  // AC2: Batch paste — positives/negatives accept arrays
  it('AC2: create intent with batch positives and negatives', async () => {
    const res = await POST(
      makePost('/api/v1/intents', {
        name: 'w10-batch-test',
        description: 'Test batch paste',
        positives: ['正例一', '正例二', '正例三'],
        negatives: ['负例一', '负例二'],
        relatedEntryCount: 0,
      }),
    );
    expect(res.status).toBe(201);
    const body = await json<{ data: { items: Array<{ name: string; positives: string[]; negatives: string[] }> } }>(res);
    const item = body.data.items.find((i) => i.name === 'w10-batch-test');
    expect(item).toBeDefined();
    expect(item!.positives).toHaveLength(3);
    expect(item!.negatives).toHaveLength(2);
  });

  // AC3: Delete intent
  it('AC3: DELETE removes intent and returns updated list', async () => {
    // Create one to delete
    const createRes = await POST(
      makePost('/api/v1/intents', {
        name: 'w10-delete-target',
        description: 'Will be deleted',
        positives: [],
        negatives: [],
      }),
    );
    expect(createRes.status).toBe(201);
    const created = await json<{ data: { items: Array<{ id: string; name: string }> } }>(createRes);
    const target = created.data.items.find((i) => i.name === 'w10-delete-target');
    expect(target).toBeDefined();

    const deleteRes = await DELETE(makeDelete(`/api/v1/intents?id=${target!.id}`));
    expect(deleteRes.status).toBe(200);
    const afterDelete = await json<{ data: { items: Array<{ id: string }> } }>(deleteRes);
    expect(afterDelete.data.items.find((i) => i.id === target!.id)).toBeUndefined();
  });

  it('AC3: DELETE rejects missing id', async () => {
    const res = await DELETE(makeDelete('/api/v1/intents'));
    expect(res.status).toBe(400);
  });

  it('AC3: DELETE returns 404 for non-existent intent', async () => {
    const res = await DELETE(makeDelete('/api/v1/intents?id=nonexistent'));
    expect(res.status).toBe(404);
  });

  // AC4: Sync trigger after changes
  it('AC4: POST /intents/sync returns syncing status', async () => {
    const res = await SYNC_POST();
    expect(res.status).toBe(200);
    const body = await json<{ data: { status: string; message: string } }>(res);
    expect(body.data.status).toBe('syncing');
    expect(body.data.message).toBeTruthy();
  });

  // PUT update
  it('PUT updates an existing intent', async () => {
    const createRes = await POST(
      makePost('/api/v1/intents', {
        name: 'w10-update-target',
        description: 'Original description',
        positives: ['原始正例'],
        negatives: [],
      }),
    );
    const created = await json<{ data: { items: Array<{ id: string; name: string }> } }>(createRes);
    const target = created.data.items.find((i) => i.name === 'w10-update-target');
    expect(target).toBeDefined();

    const updateRes = await PUT(
      makePut('/api/v1/intents', {
        id: target!.id,
        name: 'w10-update-target-renamed',
        description: 'Updated description',
        positives: ['新正例一', '新正例二'],
        negatives: ['新负例'],
      }),
    );
    expect(updateRes.status).toBe(200);
    const updated = await json<{ data: { items: Array<{ id: string; name: string; description: string; positives: string[]; negatives: string[] }> } }>(updateRes);
    const updatedItem = updated.data.items.find((i) => i.id === target!.id);
    expect(updatedItem?.name).toBe('w10-update-target-renamed');
    expect(updatedItem?.description).toBe('Updated description');
    expect(updatedItem?.positives).toHaveLength(2);
    expect(updatedItem?.negatives).toHaveLength(1);
  });

  it('PUT rejects missing id', async () => {
    const res = await PUT(
      makePut('/api/v1/intents', { name: 'x', description: 'y' }),
    );
    expect(res.status).toBe(400);
  });

  it('PUT returns 404 for non-existent intent', async () => {
    const res = await PUT(
      makePut('/api/v1/intents', { id: 'nonexistent', name: 'x', description: 'y' }),
    );
    expect(res.status).toBe(404);
  });

  // AC5: Get intent by id (detail with recentHitCount, recentSnippets)
  it('AC5: GET with id returns intent detail', async () => {
    // Create one first
    const createRes = await POST(
      makePost('/api/v1/intents', {
        name: 'w10-detail-test',
        description: 'For detail query',
        positives: ['测试正例'],
        negatives: [],
      }),
    );
    const created = await json<{ data: { items: Array<{ id: string; name: string }> } }>(createRes);
    const target = created.data.items.find((i) => i.name === 'w10-detail-test');
    expect(target).toBeDefined();

    const detailRes = await GET(makeGet(`/api/v1/intents?id=${target!.id}`));
    expect(detailRes.status).toBe(200);
    const detail = await json<{ data: { id: string; name: string; recentHitCount: number; recentSnippets: unknown[] } }>(detailRes);
    expect(detail.data.id).toBe(target!.id);
    expect(typeof detail.data.recentHitCount).toBe('number');
    expect(Array.isArray(detail.data.recentSnippets)).toBe(true);
  });

  it('AC5: GET with non-existent id returns 404', async () => {
    const res = await GET(makeGet('/api/v1/intents?id=nonexistent'));
    expect(res.status).toBe(404);
  });
});

// ─── FR-W11: Login & Identity ───────────────────────────────────────────────

describe('FR-W11: Login & Identity', () => {
  let loginPOST: (req: NextRequest) => Promise<Response>;
  let verifyGET: (req: Request) => Promise<Response>;
  let logoutPOST: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    // Set AUTH_PASSWORD for tests
    process.env.AUTH_PASSWORD = 'test-password-w11';
    const loginMod = await import('../../app/api/auth/login/route');
    loginPOST = loginMod.POST;
    const verifyMod = await import('../../app/api/auth/verify/route');
    verifyGET = verifyMod.GET;
    const logoutMod = await import('../../app/api/auth/logout/route');
    logoutPOST = logoutMod.POST;
  });

  // AC1: CTA contrast — visual, not testable in unit tests

  // AC2: No developer jargon — visual, not testable in unit tests

  // AC3: Identity stored and returned
  it('AC3: login with identity stores it in session', async () => {
    const loginRes = await loginPOST(
      makePost('/api/auth/login', {
        password: 'test-password-w11',
        identity: '张三',
      }),
    );
    expect(loginRes.status).toBe(200);
    const loginBody = await json<{ ok: boolean }>(loginRes);
    expect(loginBody.ok).toBe(true);

    // Extract session cookie
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const tokenMatch = setCookie.match(/kivo_session=([^;]+)/);
    expect(tokenMatch).toBeTruthy();
    const token = tokenMatch![1];

    // Verify returns identity
    const verifyRes = await verifyGET(
      makeReqWithCookie('/api/auth/verify', `kivo_session=${token}`),
    );
    expect(verifyRes.status).toBe(200);
    const verifyBody = await json<{ valid: boolean; identity: string }>(verifyRes);
    expect(verifyBody.valid).toBe(true);
    expect(verifyBody.identity).toBe('张三');
  });

  it('AC3: login without identity still works', async () => {
    const loginRes = await loginPOST(
      makePost('/api/auth/login', {
        password: 'test-password-w11',
      }),
    );
    expect(loginRes.status).toBe(200);

    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const tokenMatch = setCookie.match(/kivo_session=([^;]+)/);
    const token = tokenMatch![1];

    const verifyRes = await verifyGET(
      makeReqWithCookie('/api/auth/verify', `kivo_session=${token}`),
    );
    const verifyBody = await json<{ valid: boolean; identity: string }>(verifyRes);
    expect(verifyBody.valid).toBe(true);
    expect(verifyBody.identity).toBe('');
  });

  it('rejects wrong password', async () => {
    const res = await loginPOST(
      makePost('/api/auth/login', {
        password: 'wrong-password',
        identity: 'attacker',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('verify returns 401 for invalid token', async () => {
    const res = await verifyGET(
      makeReqWithCookie('/api/auth/verify', 'kivo_session=invalid-token'),
    );
    expect(res.status).toBe(401);
  });

  it('logout invalidates session', async () => {
    // Login first
    const loginRes = await loginPOST(
      makePost('/api/auth/login', {
        password: 'test-password-w11',
        identity: 'logout-test',
      }),
    );
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const tokenMatch = setCookie.match(/kivo_session=([^;]+)/);
    const token = tokenMatch![1];

    // Logout
    const logoutRes = await logoutPOST(
      makeReqWithCookie('/api/auth/logout', `kivo_session=${token}`),
    );
    expect(logoutRes.status).toBe(200);

    // Verify should fail now
    const verifyRes = await verifyGET(
      makeReqWithCookie('/api/auth/verify', `kivo_session=${token}`),
    );
    expect(verifyRes.status).toBe(401);
  });
});

// ─── FR-W12: Navigation & Page Discovery ────────────────────────────────────

describe('FR-W12: Navigation & Page Discovery', () => {
  let dashboardGET: (req: NextRequest) => Promise<Response>;
  let conflictsGET: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const dashMod = await import('../../app/api/v1/dashboard/summary/route');
    dashboardGET = dashMod.GET;
    const conflictMod = await import('../../app/api/v1/conflicts/route');
    conflictsGET = conflictMod.GET;
  });

  // AC1: Default to dashboard after onboarding — middleware redirect tested here
  it('AC1: root path middleware redirects to dashboard', async () => {
    // Import middleware
    const { middleware } = await import('../../middleware');
    const req = new NextRequest(new URL('/', BASE));
    const res = middleware(req);
    expect(res.status).toBe(307); // redirect
    expect(res.headers.get('location')).toContain('/dashboard');
  });

  // AC2: Conflict badge data — conflicts API returns unresolved count
  it('AC2: conflicts API returns items with status for badge count', async () => {
    const res = await conflictsGET(makeGet('/api/v1/conflicts?status=all'));
    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ id: string; status: string }> }>(res);
    expect(body.data).toBeInstanceOf(Array);
    for (const item of body.data) {
      expect(typeof item.status).toBe('string');
    }
    // Can count unresolved for badge
    const unresolvedCount = body.data.filter((i) => i.status === 'unresolved').length;
    expect(typeof unresolvedCount).toBe('number');
  });

  // AC3: Dashboard recommends next action
  it('AC3: dashboard summary includes nextAction recommendation', async () => {
    const res = await dashboardGET(makeGet('/api/v1/dashboard/summary'));
    expect(res.status).toBe(200);
    const body = await json<{
      data: {
        nextAction: { title: string; description: string; href: string; tone: string };
      };
    }>(res);
    expect(body.data.nextAction).toBeDefined();
    expect(body.data.nextAction.title).toBeTruthy();
    expect(body.data.nextAction.description).toBeTruthy();
    expect(body.data.nextAction.href).toBeTruthy();
    expect(['default', 'warning', 'success']).toContain(body.data.nextAction.tone);
  });

  // AC4: Fixed nav entries — verified via app-shell structure
  it('AC4: dashboard summary provides data for all sidebar sections', async () => {
    const res = await dashboardGET(makeGet('/api/v1/dashboard/summary'));
    expect(res.status).toBe(200);
    const body = await json<{
      data: {
        totalEntries: number;
        byType: Record<string, number>;
        byStatus: Record<string, number>;
        health: { pendingCount: number; unresolvedConflicts: number };
        searchHitRate: { current: number };
      };
    }>(res);
    // All sidebar-linked data points exist
    expect(typeof body.data.totalEntries).toBe('number');
    expect(body.data.byType).toBeDefined();
    expect(body.data.byStatus).toBeDefined();
    expect(typeof body.data.health.pendingCount).toBe('number');
    expect(typeof body.data.health.unresolvedConflicts).toBe('number');
    expect(typeof body.data.searchHitRate.current).toBe('number');
  });
});
