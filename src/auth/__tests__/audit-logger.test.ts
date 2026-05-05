import { describe, expect, it, beforeEach } from 'vitest';
import { AuditLogger } from '../audit-logger.js';

describe('AuditLogger', () => {
  let logger: AuditLogger;
  let idCounter: number;

  beforeEach(() => {
    idCounter = 0;
    logger = new AuditLogger({ idFactory: () => `audit-${++idCounter}` });
  });

  it('logs an entry and returns it', () => {
    const entry = logger.log('user-1', 'knowledge:import', { id: 'k1', type: 'entry' });
    expect(entry.id).toBe('audit-1');
    expect(entry.userId).toBe('user-1');
    expect(entry.action).toBe('knowledge:import');
    expect(entry.targetId).toBe('k1');
    expect(entry.timestamp).toBeInstanceOf(Date);
  });

  it('query returns all entries when no filter', () => {
    logger.log('u1', 'knowledge:import');
    logger.log('u2', 'knowledge:edit');
    expect(logger.query()).toHaveLength(2);
  });

  it('query filters by userId', () => {
    logger.log('u1', 'knowledge:import');
    logger.log('u2', 'knowledge:edit');
    const results = logger.query({ userId: 'u1' });
    expect(results).toHaveLength(1);
    expect(results[0].userId).toBe('u1');
  });

  it('query filters by action', () => {
    logger.log('u1', 'knowledge:import');
    logger.log('u1', 'knowledge:edit');
    logger.log('u1', 'knowledge:import');
    expect(logger.query({ action: 'knowledge:import' })).toHaveLength(2);
  });

  it('query filters by time range', () => {
    const e1 = logger.log('u1', 'session:login');
    // Manually adjust timestamp for testing
    (e1 as any).timestamp = new Date('2026-01-01');
    const e2 = logger.log('u1', 'session:logout');
    (e2 as any).timestamp = new Date('2026-06-01');

    const results = logger.query({ since: new Date('2026-03-01') });
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('session:logout');
  });

  it('count returns total or filtered count', () => {
    logger.log('u1', 'knowledge:import');
    logger.log('u2', 'knowledge:edit');
    expect(logger.count()).toBe(2);
    expect(logger.count({ userId: 'u1' })).toBe(1);
  });
});
