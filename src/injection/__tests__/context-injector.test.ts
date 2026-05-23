import { describe, expect, it } from 'vitest';
import { ContextInjector } from '../context-injector.js';
import type { KnowledgeEntry, KnowledgeSource } from '../../types/index.js';
import type { KnowledgeRepository } from '../../repository/index.js';

function makeSource(): KnowledgeSource {
  return { type: 'document', reference: 'doc://test', timestamp: new Date('2026-05-01T00:00:00Z') };
}

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: 'e-1',
    type: 'fact',
    title: 'Test Entry',
    content: 'This is the full content of the knowledge entry for testing purposes.',
    summary: 'A brief summary',
    source: makeSource(),
    confidence: 0.9,
    status: 'active',
    tags: ['test'],
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

/** Minimal mock repository that only implements findById */
function makeMockRepo(entries: KnowledgeEntry[]): KnowledgeRepository {
  const map = new Map(entries.map(e => [e.id, e]));
  return {
    findById: async (id: string) => map.get(id) ?? null,
    search: async () => [],
    save: async () => {},
    updateStatus: async () => {},
    getVersionHistory: async () => [],
    findByType: async () => [],
    count: async () => 0,
    delete: async () => {},
  } as unknown as KnowledgeRepository;
}

describe('ContextInjector.injectById', () => {
  it('returns formatted entry for existing id', async () => {
    const entry = makeEntry({ id: 'k-100' });
    const repo = makeMockRepo([entry]);
    const injector = new ContextInjector({ repository: repo });

    const result = await injector.injectById('k-100');

    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].entryId).toBe('k-100');
    expect(result!.disclosureMode).toBe('full');
    expect(result!.injectedContext).toContain('Test Entry');
    expect(result!.truncated).toBe(false);
  });

  it('returns null for non-existent id', async () => {
    const repo = makeMockRepo([]);
    const injector = new ContextInjector({ repository: repo });

    const result = await injector.injectById('non-existent-id');

    expect(result).toBeNull();
  });

  it('truncates content when maxTokens is exceeded', async () => {
    // Create entry with long content (~200 chars = ~50 tokens)
    const longContent = 'A'.repeat(400); // ~100 tokens
    const entry = makeEntry({ id: 'k-long', content: longContent, summary: '' });
    const repo = makeMockRepo([entry]);
    const injector = new ContextInjector({ repository: repo });

    const result = await injector.injectById('k-long', undefined, 20);

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.tokensUsed).toBe(20);
    expect(result!.injectedContext).toContain('[truncated]');
  });

  it('does not truncate when content fits within maxTokens', async () => {
    const entry = makeEntry({ id: 'k-short', content: 'Short.' });
    const repo = makeMockRepo([entry]);
    const injector = new ContextInjector({ repository: repo });

    // Give generous budget
    const result = await injector.injectById('k-short', undefined, 5000);

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);
    expect(result!.injectedContext).not.toContain('[truncated]');
  });
});
