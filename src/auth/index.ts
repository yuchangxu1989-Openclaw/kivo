export type {
  Role,
  Permission,
  User,
  Session,
  SessionOptions,
  AuditAction,
  AuditEntry,
  AuthContext,
} from './auth-types.js';
export { ROLE_PERMISSIONS, DEFAULT_SESSION_TIMEOUT_MS } from './auth-types.js';
export { hasPermission, requirePermission, getAllPermissions, PermissionDeniedError } from './permission-checker.js';
export { SessionManager, type SessionManagerOptions } from './session-manager.js';
export { UserStore, type UserStoreOptions } from './user-store.js';
export { AuditLogger, type AuditLoggerOptions } from './audit-logger.js';
