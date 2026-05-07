import type { AuditEntry, AuditAction } from './auth-types.js';

export interface AuditLoggerOptions {
  idFactory?: () => string;
}

export class AuditLogger {
  private readonly entries: AuditEntry[] = [];
  private readonly idFactory: () => string;

  constructor(options: AuditLoggerOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  log(userId: string, action: AuditAction, target?: { id?: string; type?: string; detail?: string }): AuditEntry {
    const entry: AuditEntry = {
      id: this.idFactory(),
      userId,
      action,
      targetId: target?.id,
      targetType: target?.type,
      detail: target?.detail,
      timestamp: new Date(),
    };
    this.entries.push(entry);
    return entry;
  }

  query(filter?: { userId?: string; action?: AuditAction; since?: Date; until?: Date }): AuditEntry[] {
    if (!filter) return [...this.entries];
    return this.entries.filter((e) => {
      if (filter.userId && e.userId !== filter.userId) return false;
      if (filter.action && e.action !== filter.action) return false;
      if (filter.since && e.timestamp < filter.since) return false;
      if (filter.until && e.timestamp > filter.until) return false;
      return true;
    });
  }

  count(filter?: { userId?: string; action?: AuditAction }): number {
    if (!filter) return this.entries.length;
    return this.query(filter).length;
  }
}
