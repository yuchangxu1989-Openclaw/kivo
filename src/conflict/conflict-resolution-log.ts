/**
 * ConflictResolutionLog — 冲突解决审计日志 (FR-C01 AC4)
 * 记录冲突解决过程和结论，支持复盘。
 */

import type { ConflictRecord, ResolutionStrategy } from './conflict-record.js';

export interface ResolutionLogEntry {
  conflictId: string;
  incomingId: string;
  existingId: string;
  strategy: ResolutionStrategy;
  winnerId: string;
  loserId: string;
  action: 'supersede' | 'pending_manual';
  resolvedAt: Date;
  reason?: string;
}

export class ConflictResolutionLog {
  private readonly entries: ResolutionLogEntry[] = [];

  record(entry: ResolutionLogEntry): void {
    this.entries.push({
      ...entry,
      resolvedAt: new Date(entry.resolvedAt),
    });
  }

  getAll(): ResolutionLogEntry[] {
    return this.entries.map((entry) => ({
      ...entry,
      resolvedAt: new Date(entry.resolvedAt),
    }));
  }

  getByConflictId(conflictId: string): ResolutionLogEntry | undefined {
    const entry = this.entries.find((e) => e.conflictId === conflictId);
    return entry
      ? { ...entry, resolvedAt: new Date(entry.resolvedAt) }
      : undefined;
  }

  getByEntryId(entryId: string): ResolutionLogEntry[] {
    return this.entries
      .filter((e) => e.incomingId === entryId || e.existingId === entryId)
      .map((entry) => ({ ...entry, resolvedAt: new Date(entry.resolvedAt) }));
  }

  count(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
