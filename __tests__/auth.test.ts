import { describe, expect, it, vi } from 'vitest';
import {
  hasPermission,
  requirePermission,
  getAllPermissions,
  PermissionDeniedError,
  ROLE_PERMISSIONS,
  SessionManager,
  UserStore,
  AuditLogger,
} from '../src/auth/index.js';
import type { AuthContext, Role } from '../src/auth/index.js';

// ── Permission Checker ──

describe('hasPermission', () => {
  it('admin has all permissions', () => {
    expect(hasPermission('admin', 'knowledge:read')).toBe(true);
    expect(hasPermission('admin', 'user:manage')).toBe(true);
    expect(hasPermission('admin', 'config:manage')).toBe(true);
    expect(hasPermission('admin', 'audit:read')).toBe(true);
  });

  it('editor can read and write knowledge', () => {
    expect(hasPermission('editor', 'knowledge:read')).toBe(true);
    expect(hasPermission('editor', 'knowledge:write')).toBe(true);
    expect(hasPermission('editor', 'knowledge:adjudicate')).toBe(true);
  });

  it('editor cannot manage users or delete knowledge', () => {
    expect(hasPermission('editor', 'user:manage')).toBe(false);
    expect(hasPermission('editor', 'knowledge:delete')).toBe(false);
  });

  it('viewer can only read', () => {
    expect(hasPermission('viewer', 'knowledge:read')).toBe(true);
    expect(hasPermission('viewer', 'knowledge:write')).toBe(false);
    expect(hasPermission('viewer', 'user:manage')).toBe(false);
  });
});

describe('requirePermission', () => {
  it('does not throw when permission exists', () => {
    const ctx: AuthContext = { userId: 'u1', role: 'admin', sessionId: 's1' };
    expect(() => requirePermission(ctx, 'user:manage')).not.toThrow();
  });

  it('throws PermissionDeniedError when lacking permission', () => {
    const ctx: AuthContext = { userId: 'u1', role: 'viewer', sessionId: 's1' };
    expect(() => requirePermission(ctx, 'knowledge:write')).toThrow(PermissionDeniedError);
  });
});

describe('getAllPermissions', () => {
  it('returns correct count per role', () => {
    expect(getAllPermissions('admin').length).toBe(ROLE_PERMISSIONS.admin.length);
    expect(getAllPermissions('viewer').length).toBe(1);
  });
});

// ── Session Manager ──

describe('SessionManager', () => {
  function makeManager() {
    let seq = 0;
    return new SessionManager({ idFactory: () => `sess-${++seq}`, timeoutMs: 1000 });
  }

  it('creates and validates a session', () => {
    const mgr = makeManager();
    const session = mgr.create('user-1');
    expect(session.id).toBe('sess-1');
    expect(session.active).toBe(true);
    expect(mgr.validate('sess-1')).toBeTruthy();
  });

  it('invalidates a session (logout)', () => {
    const mgr = makeManager();
    mgr.create('user-1');
    expect(mgr.invalidate('sess-1')).toBe(true);
    expect(mgr.validate('sess-1')).toBeNull();
  });

  it('returns null for expired session', () => {
    const mgr = new SessionManager({ idFactory: () => 'sess-exp', timeoutMs: -1 });
    mgr.create('user-1');
    expect(mgr.validate('sess-exp')).toBeNull();
  });

  it('invalidates all sessions for a user', () => {
    const mgr = makeManager();
    mgr.create('user-1');
    mgr.create('user-1');
    expect(mgr.invalidateAllForUser('user-1')).toBe(2);
    expect(mgr.getActiveSessions('user-1')).toHaveLength(0);
  });

  it('returns only active sessions', () => {
    const mgr = makeManager();
    mgr.create('user-1');
    mgr.create('user-2');
    mgr.invalidate('sess-1');
    expect(mgr.getActiveSessions()).toHaveLength(1);
    expect(mgr.getActiveSessions('user-2')).toHaveLength(1);
  });
});

// ── User Store ──

describe('UserStore', () => {
  function makeStore() {
    let seq = 0;
    return new UserStore({ idFactory: () => `u-${++seq}` });
  }

  it('creates a user and authenticates', () => {
    const store = makeStore();
    const user = store.createUser('alice', 'pass123', 'admin', 'system');
    expect(user.id).toBe('u-1');
    expect(user.role).toBe('admin');
    expect(store.authenticate('alice', 'pass123')).toBeTruthy();
    expect(store.authenticate('alice', 'wrong')).toBeNull();
  });

  it('rejects duplicate username', () => {
    const store = makeStore();
    store.createUser('alice', 'pass', 'admin', 'system');
    expect(() => store.createUser('alice', 'pass2', 'editor', 'system')).toThrow('Username already exists');
  });

  it('changes password', () => {
    const store = makeStore();
    store.createUser('bob', 'old', 'editor', 'system');
    expect(store.changePassword('u-1', 'old', 'new')).toBe(true);
    expect(store.authenticate('bob', 'old')).toBeNull();
    expect(store.authenticate('bob', 'new')).toBeTruthy();
  });

  it('updates role', () => {
    const store = makeStore();
    store.createUser('carol', 'pass', 'viewer', 'system');
    expect(store.updateRole('u-1', 'editor')).toBe(true);
    expect(store.getUser('u-1')!.role).toBe('editor');
  });

  it('disables user blocks authentication', () => {
    const store = makeStore();
    store.createUser('dave', 'pass', 'viewer', 'system');
    store.disableUser('u-1');
    expect(store.authenticate('dave', 'pass')).toBeNull();
  });

  it('lists all users', () => {
    const store = makeStore();
    store.createUser('a', 'p', 'admin', 'system');
    store.createUser('b', 'p', 'viewer', 'system');
    expect(store.listUsers()).toHaveLength(2);
  });

  it('looks up by username', () => {
    const store = makeStore();
    store.createUser('eve', 'pass', 'editor', 'system');
    expect(store.getUserByUsername('eve')?.id).toBe('u-1');
    expect(store.getUserByUsername('nobody')).toBeNull();
  });
});

// ── Audit Logger ──

describe('AuditLogger', () => {
  function makeLogger() {
    let seq = 0;
    return new AuditLogger({ idFactory: () => `aud-${++seq}` });
  }

  it('logs and queries audit entries', () => {
    const logger = makeLogger();
    logger.log('u-1', 'knowledge:import', { id: 'k-1', type: 'entry' });
    logger.log('u-2', 'knowledge:edit', { id: 'k-2', type: 'entry' });
    logger.log('u-1', 'knowledge:delete', { id: 'k-3', type: 'entry' });

    expect(logger.query()).toHaveLength(3);
    expect(logger.query({ userId: 'u-1' })).toHaveLength(2);
    expect(logger.query({ action: 'knowledge:edit' })).toHaveLength(1);
  });

  it('counts entries', () => {
    const logger = makeLogger();
    logger.log('u-1', 'session:login');
    logger.log('u-1', 'session:logout');
    expect(logger.count()).toBe(2);
    expect(logger.count({ action: 'session:login' })).toBe(1);
  });

  it('filters by time range', () => {
    const logger = makeLogger();
    logger.log('u-1', 'knowledge:import');
    const boundary = new Date(Date.now() + 50);
    const e2 = logger.log('u-1', 'knowledge:edit');
    // manually set timestamp after boundary
    (e2 as { timestamp: Date }).timestamp = new Date(boundary.getTime() + 1);
    expect(logger.query({ since: boundary })).toHaveLength(1);
  });
});
