import { describe, expect, it } from 'vitest';
import { ConflictResolutionLog } from '../src/conflict/conflict-resolution-log.js';
import type { ResolutionLogEntry } from '../src/conflict/conflict-resolution-log.js';

function makeLogEntry(overrides: Partial<ResolutionLogEntry> = {}): ResolutionLogEntry {
  return {
    conflictId: 'cr-1',
    incomingId: 'new-1',
    existingId: 'old-1',
    strategy: 'newer-wins',
    winnerId: 'new-1',
    loserId: 'old-1',
    action: 'supersede',
    resolvedAt: new Date('2026-04-20T12:00:00.000Z'),
    ...overrides,
  };
}

describe('ConflictResolutionLog (FR-C01 AC4)', () => {
  it('records and retrieves resolution entries', () => {
    const log = new ConflictResolutionLog();
    log.record(makeLogEntry());

    const all = log.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      conflictId: 'cr-1',
      strategy: 'newer-wins',
      winnerId: 'new-1',
      action: 'supersede',
    });
  });

  it('retrieves entry by conflict id', () => {
    const log = new ConflictResolutionLog();
    log.record(makeLogEntry({ conflictId: 'cr-1' }));
    log.record(makeLogEntry({ conflictId: 'cr-2', strategy: 'confidence-wins' }));

    const entry = log.getByConflictId('cr-2');
    expect(entry).toBeDefined();
    expect(entry!.strategy).toBe('confidence-wins');

    expect(log.getByConflictId('cr-nonexistent')).toBeUndefined();
  });

  it('retrieves entries by knowledge entry id (incoming or existing)', () => {
    const log = new ConflictResolutionLog();
    log.record(makeLogEntry({ conflictId: 'cr-1', incomingId: 'entry-a', existingId: 'entry-b' }));
    log.record(makeLogEntry({ conflictId: 'cr-2', incomingId: 'entry-c', existingId: 'entry-a' }));
    log.record(makeLogEntry({ conflictId: 'cr-3', incomingId: 'entry-d', existingId: 'entry-e' }));

    const entriesForA = log.getByEntryId('entry-a');
    expect(entriesForA).toHaveLength(2);
    expect(entriesForA.map((e) => e.conflictId).sort()).toEqual(['cr-1', 'cr-2']);
  });

  it('records manual resolution with pending action', () => {
    const log = new ConflictResolutionLog();
    log.record(makeLogEntry({
      conflictId: 'cr-manual',
      strategy: 'manual',
      action: 'pending_manual',
      reason: 'User needs to decide between conflicting deployment strategies',
    }));

    const entry = log.getByConflictId('cr-manual');
    expect(entry).toMatchObject({
      strategy: 'manual',
      action: 'pending_manual',
      reason: 'User needs to decide between conflicting deployment strategies',
    });
  });

  it('returns defensive copies of dates', () => {
    const log = new ConflictResolutionLog();
    log.record(makeLogEntry());

    const entry1 = log.getAll()[0];
    entry1.resolvedAt = new Date('2000-01-01T00:00:00.000Z');

    const entry2 = log.getAll()[0];
    expect(entry2.resolvedAt).toEqual(new Date('2026-04-20T12:00:00.000Z'));
  });

  it('tracks count and supports clear', () => {
    const log = new ConflictResolutionLog();
    expect(log.count()).toBe(0);

    log.record(makeLogEntry({ conflictId: 'cr-1' }));
    log.record(makeLogEntry({ conflictId: 'cr-2' }));
    expect(log.count()).toBe(2);

    log.clear();
    expect(log.count()).toBe(0);
    expect(log.getAll()).toEqual([]);
  });
});
