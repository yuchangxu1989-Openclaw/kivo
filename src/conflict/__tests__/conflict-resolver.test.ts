import { describe, expect, it } from 'vitest';
import { ConflictResolver } from '../conflict-resolver.js';
import type { ConflictRecord } from '../conflict-record.js';
import type { KnowledgeEntry } from '../../types/index.js';

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: overrides.id ?? 'e-1',
    type: 'fact',
    title: 'Test',
    content: 'c',
    summary: 's',
    source: { type: 'manual', reference: 'test', timestamp: new Date() },
    confidence: 0.9,
    status: 'active',
    tags: [],
    domain: 'default',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    version: 1,
    ...overrides,
  };
}

function makeRecord(): ConflictRecord {
  return {
    id: 'cr-1',
    incomingId: 'in',
    existingId: 'ex',
    verdict: 'conflict',
    detectedAt: new Date(),
    resolved: false,
  };
}

describe('ConflictResolver', () => {
  const resolver = new ConflictResolver();

  describe('newer-wins strategy', () => {
    it('incoming wins when newer', () => {
      const incoming = makeEntry({ id: 'in', createdAt: new Date('2026-06-01') });
      const existing = makeEntry({ id: 'ex', createdAt: new Date('2026-01-01') });
      const result = resolver.resolve(makeRecord(), incoming, existing, 'newer-wins');

      expect(result.winnerId).toBe('in');
      expect(result.loserId).toBe('ex');
      expect(result.action).toBe('supersede');
      expect(result.record.resolved).toBe(true);
      expect(result.record.resolution).toBe('newer-wins');
    });

    it('existing wins when newer', () => {
      const incoming = makeEntry({ id: 'in', createdAt: new Date('2025-01-01') });
      const existing = makeEntry({ id: 'ex', createdAt: new Date('2026-06-01') });
      const result = resolver.resolve(makeRecord(), incoming, existing, 'newer-wins');

      expect(result.winnerId).toBe('ex');
      expect(result.loserId).toBe('in');
    });
  });

  describe('confidence-wins strategy', () => {
    it('higher confidence wins', () => {
      const incoming = makeEntry({ id: 'in', confidence: 0.95 });
      const existing = makeEntry({ id: 'ex', confidence: 0.7 });
      const result = resolver.resolve(makeRecord(), incoming, existing, 'confidence-wins');

      expect(result.winnerId).toBe('in');
      expect(result.loserId).toBe('ex');
      expect(result.action).toBe('supersede');
    });

    it('incoming wins on tie (equal confidence)', () => {
      const incoming = makeEntry({ id: 'in', confidence: 0.8 });
      const existing = makeEntry({ id: 'ex', confidence: 0.8 });
      const result = resolver.resolve(makeRecord(), incoming, existing, 'confidence-wins');

      expect(result.winnerId).toBe('in');
    });
  });

  describe('manual strategy', () => {
    it('returns pending_manual action', () => {
      const incoming = makeEntry({ id: 'in' });
      const existing = makeEntry({ id: 'ex' });
      const result = resolver.resolve(makeRecord(), incoming, existing, 'manual');

      expect(result.action).toBe('pending_manual');
      expect(result.record.resolved).toBe(false);
      expect(result.record.resolution).toBe('manual');
    });
  });
});
