import { describe, expect, it, beforeEach } from 'vitest';
import { ConflictResolutionLog } from '../conflict-resolution-log.js';
import type { ResolutionLogEntry } from '../conflict-resolution-log.js';

function makeLogEntry(overrides: Partial<ResolutionLogEntry> = {}): ResolutionLogEntry {
  return {
    conflictId: 'c-1',
    incomingId: 'in-1',
    existingId: 'ex-1',
    strategy: 'newer-wins',
    winnerId: 'in-1',
    loserId: 'ex-1',
    action: 'supersede',
    resolvedAt: new Date('2026-05-01'),
    ...overrides,
  };
}

describe('ConflictResolutionLog', () => {
  let log: ConflictResolutionLog;

  beforeEach(() => {
    log = new ConflictResolutionLog();
  });

  it('starts empty', () => {
    expect(log.count()).toBe(0);
    expect(log.getAll()).toEqual([]);
  });

  it('records and retrieves entries', () => {
    log.record(makeLogEntry());
    expect(log.count()).toBe(1);
    const all = log.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].conflictId).toBe('c-1');
  });

  it('getByConflictId returns matching entry', () => {
    log.record(makeLogEntry({ conflictId: 'c-1' }));
    log.record(makeLogEntry({ conflictId: 'c-2' }));
    const found = log.getByConflictId('c-1');
    expect(found).toBeDefined();
    expect(found!.conflictId).toBe('c-1');
  });

  it('getByConflictId returns undefined for missing', () => {
    expect(log.getByConflictId('nonexistent')).toBeUndefined();
  });

  it('getByEntryId finds entries by incoming or existing id', () => {
    log.record(makeLogEntry({ incomingId: 'a', existingId: 'b' }));
    log.record(makeLogEntry({ conflictId: 'c-2', incomingId: 'c', existingId: 'a' }));

    const results = log.getByEntryId('a');
    expect(results).toHaveLength(2);
  });

  it('clear removes all entries', () => {
    log.record(makeLogEntry());
    log.record(makeLogEntry({ conflictId: 'c-2' }));
    expect(log.count()).toBe(2);
    log.clear();
    expect(log.count()).toBe(0);
  });

  it('returns defensive copies (not references)', () => {
    log.record(makeLogEntry());
    const all1 = log.getAll();
    const all2 = log.getAll();
    expect(all1[0]).not.toBe(all2[0]); // different object references
    expect(all1[0]).toEqual(all2[0]);   // same data
  });
});
