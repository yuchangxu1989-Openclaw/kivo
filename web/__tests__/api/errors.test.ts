import { describe, it, expect } from 'vitest';
import { errorResponse, badRequest, notFound, serverError, versionConflict } from '@/lib/errors';

describe('lib/errors — FR-Z04 three-segment error format', () => {
  it('errorResponse returns three-segment body with code, message, hint', async () => {
    const res = errorResponse('BAD_REQUEST', 'missing title', 400);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toBe('missing title');
    expect(body.error.hint).toBe('请检查请求参数后重试');
  });

  it('errorResponse uses caller-provided hint over default', async () => {
    const res = errorResponse('BAD_REQUEST', 'missing title', 400, undefined, '请补全 title 字段后重试');
    const body = await res.json();
    expect(body.error.hint).toBe('请补全 title 字段后重试');
  });

  it('errorResponse falls back to generic hint for unknown codes', async () => {
    const res = errorResponse('UNKNOWN_CODE', 'something', 500);
    const body = await res.json();
    expect(body.error.hint).toBe('请稍后重试或联系支持');
  });

  it('errorResponse includes details when provided', async () => {
    const res = errorResponse('BAD_REQUEST', 'invalid', 400, { field: 'title' });
    const body = await res.json();
    expect(body.error.details).toEqual({ field: 'title' });
  });

  it('badRequest returns 400 with default hint', async () => {
    const res = badRequest('field is required');
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.hint).toBe('请检查请求参数后重试');
  });

  it('badRequest accepts custom hint', async () => {
    const res = badRequest('title is empty', undefined, '请填写标题后重试');
    const body = await res.json();
    expect(body.error.hint).toBe('请填写标题后重试');
  });

  it('notFound returns 404 with default hint', async () => {
    const res = notFound('Material 123 不存在');
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.hint).toBe('请确认资源是否存在，或刷新页面后重试');
  });

  it('notFound accepts custom hint', async () => {
    const res = notFound('not found', '请检查 ID 是否正确');
    const body = await res.json();
    expect(body.error.hint).toBe('请检查 ID 是否正确');
  });

  it('serverError returns 500 with default hint', async () => {
    const res = serverError('db connection failed');
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.hint).toBe('请稍后重试，若持续出现请联系管理员');
  });

  it('versionConflict returns 409 with hint and details', async () => {
    const res = versionConflict(3, 2, 'req-abc');
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('VERSION_CONFLICT');
    expect(body.error.hint).toBe('请刷新页面获取最新版本后重试');
    expect(body.error.details).toEqual({
      currentVersion: 3,
      expectedVersion: 2,
      requestId: 'req-abc',
    });
  });

  it('CONFLICT code gets correct default hint via errorResponse', async () => {
    const res = errorResponse('CONFLICT', 'already exists', 409);
    const body = await res.json();
    expect(body.error.hint).toBe('数据已被其他操作修改，请刷新后重试');
  });

  it('CLASSIFY_FAILED code gets correct default hint', async () => {
    const res = errorResponse('CLASSIFY_FAILED', 'classify failed', 502);
    const body = await res.json();
    expect(body.error.hint).toBe('分类服务暂时不可用，请稍后重试');
  });
});
