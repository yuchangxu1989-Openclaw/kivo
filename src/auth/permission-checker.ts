import type { Role, Permission, AuthContext } from './auth-types.js';
import { ROLE_PERMISSIONS } from './auth-types.js';

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function requirePermission(ctx: AuthContext, permission: Permission): void {
  if (!hasPermission(ctx.role, permission)) {
    throw new PermissionDeniedError(ctx.userId, permission);
  }
}

export function getAllPermissions(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export class PermissionDeniedError extends Error {
  readonly userId: string;
  readonly permission: Permission;

  constructor(userId: string, permission: Permission) {
    super(`User ${userId} lacks permission: ${permission}`);
    this.name = 'PermissionDeniedError';
    this.userId = userId;
    this.permission = permission;
  }
}
