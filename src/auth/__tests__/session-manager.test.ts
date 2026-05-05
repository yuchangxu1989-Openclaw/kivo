import { describe, expect, it, beforeEach } from 'vitest';
import { SessionManager } from '../session-manager.js';

describe('SessionManager', () => {
  let manager: SessionManager;
  let idCounter: number;

  beforeEach(() => {
    idCounter = 0;
    manager = new SessionManager({
      timeoutMs: 60_000, // 1 minute for tests
      idFactory: () => `sess-${++idCounter}`,
    });
  });

  it('creates a session with correct fields', () => {
    const session = manager.create('user-1');
    expect(session.id).toBe('sess-1');
    expect(session.userId).toBe('user-1');
    expect(session.active).toBe(true);
    expect(session.expiresAt.getTime()).toBeGreaterThan(session.createdAt.getTime());
  });

  it('validates active session', () => {
    const session = manager.create('user-1');
    const validated = manager.validate(session.id);
    expect(validated).not.toBeNull();
    expect(validated!.userId).toBe('user-1');
  });

  it('returns null for nonexistent session', () => {
    expect(manager.validate('nonexistent')).toBeNull();
  });

  it('returns null for expired session', () => {
    const mgr = new SessionManager({
      timeoutMs: -1, // already expired
      idFactory: () => 'expired-sess',
    });
    const session = mgr.create('user-1');
    expect(mgr.validate(session.id)).toBeNull();
  });

  it('invalidates a session', () => {
    const session = manager.create('user-1');
    expect(manager.invalidate(session.id)).toBe(true);
    expect(manager.validate(session.id)).toBeNull();
  });

  it('invalidate returns false for already inactive', () => {
    const session = manager.create('user-1');
    manager.invalidate(session.id);
    expect(manager.invalidate(session.id)).toBe(false);
  });

  it('invalidateAllForUser invalidates all sessions for a user', () => {
    manager.create('user-1');
    manager.create('user-1');
    manager.create('user-2');
    const count = manager.invalidateAllForUser('user-1');
    expect(count).toBe(2);
    expect(manager.getActiveSessions('user-1')).toHaveLength(0);
    expect(manager.getActiveSessions('user-2')).toHaveLength(1);
  });

  it('getActiveSessions returns only active non-expired sessions', () => {
    manager.create('user-1');
    manager.create('user-1');
    const s3 = manager.create('user-1');
    manager.invalidate(s3.id);
    expect(manager.getActiveSessions('user-1')).toHaveLength(2);
  });

  it('getActiveSessions without userId returns all active', () => {
    manager.create('user-1');
    manager.create('user-2');
    expect(manager.getActiveSessions()).toHaveLength(2);
  });

  it('respects custom timeout per session', () => {
    const session = manager.create('user-1', { timeoutMs: -1 });
    expect(manager.validate(session.id)).toBeNull();
  });
});
