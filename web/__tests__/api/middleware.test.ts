import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../middleware';

const BASE = 'http://localhost:3000';

function makeRequest(path: string): NextRequest {
  return new NextRequest(new URL(path, BASE));
}

describe('middleware public API route whitelist', () => {
  it.each([
    '/api/internal/dispatcher/tick',
    '/api/auth/login',
    '/api/v1/search',
  ])('allows exact or slash-boundary public route %s through to the route handler', (path) => {
    const res = middleware(makeRequest(path));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it.each([
    '/api/internal-foo/whatever',
    '/api/internalbypass',
    '/api/auth-fake/login',
    '/api/v1/search-fake',
  ])('does not allow prefix ghost route %s', async (path) => {
    const res = middleware(makeRequest(path));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });
});
