import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TermSearch } from '../term-search.js';
import type { KnowledgeEntry } from '../../types/index.js';
import type { StorageAdapter } from '../../storage/storage-types.js';
import type { TermMetadata } from '../term-types.js';
import { DICTIONARY_DOMAIN } from '../term-types.js';

function makeTerm(term: string, aliases: string[] = [], scope: string[] = ['global']): KnowledgeEntry {
  return {
    id: `term-${term}`,
    type: 'fact',
    title: term,
    content: `Definition of ${term}`,
    summary: `Definition of ${term}`,
    source: { type: 'manual', reference: 'test', timestamp: new Date() },
    confidence: 1.0,
    status: 'active',
    tags: ['term', ...scope],
    domain: DICTIONARY_DOMAIN,
    metadata: {
      term,
      aliases,
      definition: `Definition of ${term}`,
      constraints: [],
      positiveExamples: [],
      negativeExamples: [],
      scope,
    } as TermMetadata,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
  };
}

function mockStore(entries: KnowledgeEntry[]): StorageAdapter {
  return {
    save: vi.fn(),
    saveMany: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    query: vi.fn().mockResolvedValue({ items: entries, total: entries.length }),
    getVersionHistory: vi.fn(),
  };
}

describe('TermSearch', () => {
  describe('exactMatch', () => {
    it('finds term by exact name (case insensitive)', async () => {
      const store = mockStore([makeTerm('API'), makeTerm('SDK')]);
      const search = new TermSearch({ store });
      const result = await search.exactMatch('api');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('term-API');
    });

    it('finds term by alias', async () => {
      const store = mockStore([makeTerm('Application Programming Interface', ['API'])]);
      const search = new TermSearch({ store });
      const result = await search.exactMatch('api');
      expect(result).not.toBeNull();
    });

    it('returns null when no match', async () => {
      const store = mockStore([makeTerm('API')]);
      const search = new TermSearch({ store });
      expect(await search.exactMatch('nonexistent')).toBeNull();
    });

    it('respects scope filter', async () => {
      const store = mockStore([makeTerm('API', [], ['backend'])]);
      const search = new TermSearch({ store });
      expect(await search.exactMatch('API', 'frontend')).toBeNull();
      expect(await search.exactMatch('API', 'backend')).not.toBeNull();
    });
  });

  describe('searchByDomain', () => {
    it('returns scored results matching query keywords', async () => {
      const store = mockStore([
        makeTerm('REST API'),
        makeTerm('GraphQL'),
        makeTerm('Database'),
      ]);
      const search = new TermSearch({ store });
      const results = await search.searchByDomain('API');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('returns empty for no matches', async () => {
      const store = mockStore([makeTerm('API')]);
      const search = new TermSearch({ store });
      const results = await search.searchByDomain('zzzzz');
      expect(results).toEqual([]);
    });

    it('respects topK limit', async () => {
      const entries = Array.from({ length: 20 }, (_, i) => makeTerm(`term${i} common`));
      const store = mockStore(entries);
      const search = new TermSearch({ store });
      const results = await search.searchByDomain('common', 5);
      expect(results.length).toBeLessThanOrEqual(5);
    });
  });
});
