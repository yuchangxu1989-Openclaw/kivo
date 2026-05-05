import { describe, expect, it } from 'vitest';
import {
  hasPermission,
  requirePermission,
  getAllPermissions,
  PermissionDeniedError,
} from '../permission-checker.js';
import type { AuthContext } from '../auth-types.js';

describe('permission-checker', () => {
  describe('hasPermission', () => {
    it('admin has all permissions', () => {
      expect(hasPermission('admin', 'knowledge:read')).toBe(true);
      expect(hasPermission('admin', 'knowledge:write')).toBe(true);
      expect(hasPermission('admin', 'knowledge:delete')).toBe(true);
      expect(hasPermission('admin', 'user:manage')).toBe(true);
      expect(hasPermission('admin', 'config:manage')).toBe(true);
      expect(hasPermission('admin', 'audit:read')).toBe(true);
    });

    it('editor has read/write/adjudicate but not delete/manage', () => {
      expect(hasPermission('editor', 'knowledge:read')).toBe(true);
      expect(hasPermission('editor', 'knowledge:write')).toBe(true);
      expect(hasPermission('editor', 'knowledge:adjudicate')).toBe(true);
      expect(hasPermission('editor', 'knowledge:delete')).toBe(false);
      expect(hasPermission('editor', 'user:manage')).toBe(false);
    });

    it('viewer has only read', () => {
      expect(hasPermission('viewer', 'knowledge:read')).toBe(true);
      expect(hasPermission('viewer', 'knowledge:write')).toBe(false);
      expect(hasPermission('viewer', 'knowledge:delete')).toBe(false);
    });
  });

  describe('requirePermission', () => {
    it('does not throw when permission exists', () => {
      const ctx: AuthContext = { userId: 'u1', role: 'admin', sessionId: 's1' };
      expect(() => requirePermission(ctx, 'knowledge:delete')).not.toThrow();
    });

    it('throws PermissionDeniedError when lacking permission', () => {
      const ctx: AuthContext = { userId: 'u1', role: 'viewer', sessionId: 's1' };
      expect(() => requirePermission(ctx, 'knowledge:write')).toThrow(PermissionDeniedError);
    });

    it('error contains userId and permission', () => {
      const ctx: AuthContext = { userId: 'u1', role: 'viewer', sessionId: 's1' };
      try {
        requirePermission(ctx, 'knowledge:write');
      } catch (e) {
        expect(e).toBeInstanceOf(PermissionDeniedError);
        expect((e as PermissionDeniedError).userId).toBe('u1');
        expect((e as PermissionDeniedError).permission).toBe('knowledge:write');
      }
    });
  });

  describe('getAllPermissions', () => {
    it('returns all permissions for a role', () => {
      const adminPerms = getAllPermissions('admin');
      expect(adminPerms.length).toBe(8);
      const viewerPerms = getAllPermissions('viewer');
      expect(viewerPerms.length).toBe(1);
    });
  });
});
