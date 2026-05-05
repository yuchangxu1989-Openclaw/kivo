export type Role = 'admin' | 'editor' | 'viewer';

export type Permission =
  | 'knowledge:read'
  | 'knowledge:write'
  | 'knowledge:delete'
  | 'knowledge:adjudicate'
  | 'knowledge:deprecate'
  | 'user:manage'
  | 'config:manage'
  | 'audit:read';

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: [
    'knowledge:read', 'knowledge:write', 'knowledge:delete',
    'knowledge:adjudicate', 'knowledge:deprecate',
    'user:manage', 'config:manage', 'audit:read',
  ],
  editor: [
    'knowledge:read', 'knowledge:write',
    'knowledge:adjudicate',
  ],
  viewer: [
    'knowledge:read',
  ],
} as const;

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  disabled: boolean;
}

export interface Session {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  active: boolean;
}

export interface SessionOptions {
  timeoutMs?: number;
}

export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export type AuditAction =
  | 'knowledge:import'
  | 'knowledge:edit'
  | 'knowledge:adjudicate'
  | 'knowledge:delete'
  | 'knowledge:deprecate'
  | 'user:create'
  | 'user:update'
  | 'session:login'
  | 'session:logout';

export interface AuditEntry {
  id: string;
  userId: string;
  action: AuditAction;
  targetId?: string;
  targetType?: string;
  detail?: string;
  timestamp: Date;
}

export interface AuthContext {
  userId: string;
  role: Role;
  sessionId: string;
}
