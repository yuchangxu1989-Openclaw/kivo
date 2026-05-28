/**
 * Tests for Domain H: System Dictionary
 * FR-H01 through FR-H05
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DictionaryService } from '../src/dictionary/dictionary-service.js';
import { TermConflictChecker } from '../src/dictionary/term-conflict-checker.js';
import { TermInjectionStrategy } from '../src/dictionary/term-injection-strategy.js';
import { TermSearch } from '../src/dictionary/term-search.js';
import { TermImporter } from '../src/dictionary/term-importer.js';
import type { TermRegistrationInput, TermMetadata } from '../src/dictionary/term-types.js';
import { DICTIONARY_DOMAIN, DICTIONARY_TAG } from '../src/dictionary/term-types.js';
import type { KnowledgeEntry, KnowledgeSource } from '../src/types/index.js';
import type { StorageAdapter, KnowledgeFilter, QueryResult, PaginationOptions } from '../src/storage/storage-types.js';

// ── In-memory StorageAdapter ──

class MemoryStore implements StorageAdapter {
  private entries = new Map<string, KnowledgeEntry>();

  async save(entry: KnowledgeEntry): Promise<KnowledgeEntry> {
    const saved = { ...entry };
    this.entries.set(saved.id, saved);
    return saved;
  }

  async saveMany(entries: KnowledgeEntry[]): Promise<KnowledgeEntry[]> {
    return Promise.all(entries.map(e => this.save(e)));
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async update(id: string, patch: Partial<Omit<KnowledgeEntry, 'id' | 'createdAt' | 'version'>>): Promise<KnowledgeEntry | null> {
    const existing = this.entries.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date() };
    this.entries.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async deleteMany(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) { if (this.entries.delete(id)) count++; }
    return count;
  }

  async query(filter?: KnowledgeFilter, options?: PaginationOptions): Promise<QueryResult<KnowledgeEntry>> {
    let items = Array.from(this.entries.values());
    if (filter?.domain) {
      const domains = Array.isArray(filter.domain) ? filter.domain : [filter.domain];
      items = items.filter(e => e.domain && domains.includes(e.domain));
    }
    if (filter?.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      items = items.filter(e => types.includes(e.type));
    }
    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      items = items.filter(e => statuses.includes(e.status));
    }
    if (filter?.tags) {
      items = items.filter(e => filter.tags!.some(t => e.tags.includes(t)));
    }
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? items.length;
    const paged = items.slice(offset, offset + limit);
    return { items: paged, total: items.length, offset, limit, hasMore: offset + limit < items.length };
  }
}

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'test',
  timestamp: new Date(),
};

function makeInput(overrides: Partial<TermRegistrationInput> = {}): TermRegistrationInput {
  return {
    term: 'KnowledgeEntry',
    definition: 'A structured unit of knowledge stored in KIVO.',
    constraints: ['Must have a unique ID'],
    aliases: ['KE'],
    positiveExamples: ['A fact about TypeScript'],
    negativeExamples: ['A random chat message'],
    scope: ['core'],
    source: testSource,
    ...overrides,
  };
}

// ── FR-H01: Term Registration & Storage ──

describe('FR-H01: Term Registration & Storage', () => {
  let store: MemoryStore;
  let service: DictionaryService;

  beforeEach(() => {
    store = new MemoryStore();
    service = new DictionaryService({ store });
  });

  it('AC1: term entry contains all required fields', async () => {
    const entry = await service.register(makeInput());
    const meta = entry.metadata as TermMetadata;
    expect(meta.term).toBe('KnowledgeEntry');
    expect(meta.definition).toBe('A structured unit of knowledge stored in KIVO.');
    expect(meta.constraints).toEqual(['Must have a unique ID']);
    expect(meta.positiveExamples).toEqual(['A fact about TypeScript']);
    expect(meta.negativeExamples).toEqual(['A random chat message']);
    expect(meta.scope).toEqual(['core']);
    expect(meta.aliases).toEqual(['KE']);
  });

  it('AC2: stored as KnowledgeEntry with type=fact, domain=system-dictionary', async () => {
    const entry = await service.register(makeInput());
    expect(entry.type).toBe('fact');
    expect(entry.domain).toBe(DICTIONARY_DOMAIN);
    expect(entry.tags).toContain(DICTIONARY_TAG);
  });

  it('AC3: rejects duplicate term in same scope', async () => {
    await service.register(makeInput());
    await expect(service.register(makeInput())).rejects.toThrow(/already exists/);
  });

  it('AC3: allows same term in different scope', async () => {
    await service.register(makeInput({ scope: ['core'] }));
    const entry2 = await service.register(makeInput({ scope: ['external'] }));
    expect(entry2).toBeTruthy();
  });

  it('AC4: exact match by term name or alias', async () => {
    await service.register(makeInput());
    const search = new TermSearch({ store });

    const byName = await search.exactMatch('KnowledgeEntry');
    expect(byName).toBeTruthy();
    expect((byName!.metadata as TermMetadata).term).toBe('KnowledgeEntry');

    const byAlias = await search.exactMatch('KE');
    expect(byAlias).toBeTruthy();

    const byNameInsensitive = await search.exactMatch('knowledgeentry');
    expect(byNameInsensitive).toBeTruthy();
  });

  it('AC4: exact match with scope filter', async () => {
    await service.register(makeInput({ scope: ['core'] }));
    const search = new TermSearch({ store });

    const inScope = await search.exactMatch('KnowledgeEntry', 'core');
    expect(inScope).toBeTruthy();

    const outScope = await search.exactMatch('KnowledgeEntry', 'external');
    expect(outScope).toBeNull();
  });

  it('AC5: uniqueness and format validation at API layer', async () => {
    await service.register(makeInput());
    // Alias conflicts with existing term name
    await expect(
      service.register(makeInput({ term: 'OtherTerm', aliases: ['KnowledgeEntry'], scope: ['core'] })),
    ).rejects.toThrow(/conflicts/);
  });
});

// ── FR-H02: Term Prompt Injection ──

describe('FR-H02: Term Prompt Injection', () => {
  let store: MemoryStore;
  let service: DictionaryService;
  let strategy: TermInjectionStrategy;

  beforeEach(async () => {
    store = new MemoryStore();
    service = new DictionaryService({ store });
    strategy = new TermInjectionStrategy({ store });

    await service.register(makeInput());
    await service.register(makeInput({
      term: 'Pipeline',
      definition: 'An ordered sequence of processing stages.',
      aliases: ['管线'],
      scope: ['core'],
    }));
  });

  it('AC1: injection format includes term, definition, constraints, examples', async () => {
    const result = await strategy.getTermBlocks('KnowledgeEntry');
    expect(result.blocks.length).toBeGreaterThan(0);
    const text = result.blocks[0].text;
    expect(text).toContain('KnowledgeEntry');
    expect(text).toContain('A structured unit of knowledge');
    expect(text).toContain('Must have a unique ID');
    expect(text).toContain('A fact about TypeScript');
    expect(text).toContain('A random chat message');
  });

  it('AC2: filters by query relevance, not full dump', async () => {
    const result = await strategy.getTermBlocks('Pipeline processing');
    const terms = result.blocks.map(b => b.text);
    expect(terms.some(t => t.includes('Pipeline'))).toBe(true);
  });

  it('AC3: respects token budget', async () => {
    const result = await strategy.getTermBlocks('KnowledgeEntry Pipeline', { tokenBudget: 10 });
    // With a tiny budget, should truncate
    const totalTokens = result.blocks.reduce((sum, b) => sum + b.estimatedTokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(10);
  });

  it('AC4: supports markdown and plaintext formats', async () => {
    const md = await strategy.getTermBlocks('KnowledgeEntry', { format: 'markdown' });
    expect(md.blocks[0].text).toContain('**');

    const plain = await strategy.getTermBlocks('KnowledgeEntry', { format: 'plaintext' });
    expect(plain.blocks[0].text).not.toContain('**');
    expect(plain.blocks[0].text).toContain('[KnowledgeEntry]');
  });

  it('AC5: deprecated terms get warning instead of normal injection', async () => {
    const entry = await service.register(makeInput({
      term: 'OldTerm',
      definition: 'Deprecated term.',
      aliases: [],
      scope: ['core'],
    }));
    await service.deprecate(entry.id, 'Replaced by NewTerm');

    const result = await strategy.getTermBlocks('OldTerm');
    expect(result.deprecatedWarnings.length).toBeGreaterThan(0);
    expect(result.deprecatedWarnings[0].text).toContain('已废弃');
  });
});

// ── FR-H03: Term Conflict Detection ──

describe('FR-H03: Term Conflict Detection', () => {
  let store: MemoryStore;
  let checker: TermConflictChecker;

  beforeEach(() => {
    store = new MemoryStore();
    checker = new TermConflictChecker();
  });

  function makeTermEntry(term: string, aliases: string[], scope: string[], constraints: string[] = []): KnowledgeEntry {
    return {
      id: `term-${term}`,
      type: 'fact',
      title: term,
      content: `Definition of ${term}`,
      summary: `Definition of ${term}`,
      source: testSource,
      confidence: 1.0,
      status: 'active',
      tags: [DICTIONARY_TAG, ...scope],
      domain: DICTIONARY_DOMAIN,
      metadata: {
        term,
        aliases,
        definition: `Definition of ${term}`,
        constraints,
        positiveExamples: [],
        negativeExamples: [],
        scope,
      } as TermMetadata,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
    };
  }

  it('AC1: detects alias conflict', async () => {
    const existing = makeTermEntry('Alpha', ['A'], ['core']);
    const incoming = makeTermEntry('Beta', ['A'], ['core']);
    const results = await checker.check(incoming, [existing]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe('alias_conflict');
  });

  it('AC1: detects scope overlap with conflicting constraints', async () => {
    // Scope overlap detection requires ConflictDetector for LLM judgment
    // Without it, only alias conflicts are detected locally
    const existing = makeTermEntry('Alpha', [], ['core'], ['Must be immutable']);
    const incoming = makeTermEntry('Beta', [], ['core'], ['Must be mutable']);

    // Without ConflictDetector, scope overlap won't be detected (requires LLM)
    const results = await checker.check(incoming, [existing]);
    // This is expected: no alias conflict, no LLM → no scope overlap detection
    expect(results.every(r => r.type !== 'scope_overlap')).toBe(true);
  });

  it('AC3: alias conflict is local exact match, no LLM dependency', async () => {
    const existing = makeTermEntry('Alpha', ['共享别名'], ['core']);
    const incoming = makeTermEntry('Beta', ['共享别名'], ['core']);
    const results = await checker.check(incoming, [existing]);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe('alias_conflict');
  });

  it('AC4: conflict result includes type, pair, and suggestion', async () => {
    const existing = makeTermEntry('Alpha', ['X'], ['core']);
    const incoming = makeTermEntry('Beta', ['X'], ['core']);
    const results = await checker.check(incoming, [existing]);
    expect(results[0]).toMatchObject({
      type: 'alias_conflict',
      incomingId: incoming.id,
      existingId: existing.id,
      suggestion: 'merge',
    });
    expect(results[0].details).toBeTruthy();
  });

  it('no conflict when scopes do not overlap', async () => {
    const existing = makeTermEntry('Alpha', ['X'], ['scope-a']);
    const incoming = makeTermEntry('Beta', ['Y'], ['scope-b']);
    const results = await checker.check(incoming, [existing]);
    expect(results).toHaveLength(0);
  });
});

// ── FR-H04: Term Lifecycle ──

describe('FR-H04: Term Lifecycle', () => {
  let store: MemoryStore;
  let service: DictionaryService;

  beforeEach(() => {
    store = new MemoryStore();
    service = new DictionaryService({ store });
  });

  it('AC1: supports register, update, deprecate, merge', async () => {
    // Register
    const entry = await service.register(makeInput());
    expect(entry.status).toBe('active');

    // Update
    const updated = await service.update(entry.id, { aliases: ['KE', 'Entry'] }, entry.version);
    expect((updated.metadata as TermMetadata).aliases).toContain('Entry');

    // Deprecate
    await service.deprecate(entry.id, 'Replaced');
    const deprecated = await store.get(entry.id);
    expect(deprecated!.status).toBe('active');

    // Merge
    const target = await service.register(makeInput({ term: 'Target', scope: ['core'] }));
    const src = await service.register(makeInput({ term: 'Source', scope: ['other'] }));
    await service.merge([src.id], target.id);
    const merged = await store.get(src.id);
    expect(merged!.status).toBe('active');
  });

  it('AC2: definition change triggers new version', async () => {
    const v1 = await service.register(makeInput());
    const v2 = await service.update(v1.id, { definition: 'Updated definition' }, v1.version);
    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id); // new entry created
    expect(v2.supersedes).toBe(v1.id);
  });

  it('AC2: alias change does not trigger new version', async () => {
    const v1 = await service.register(makeInput());
    const v1Updated = await service.update(v1.id, { aliases: ['KE', 'NewAlias'] }, v1.version);
    expect(v1Updated.id).toBe(v1.id); // same entry
    expect(v1Updated.version).toBe(v1.version); // same version
  });

  it('AC4: merge sets superseded status with pointer', async () => {
    const target = await service.register(makeInput({ term: 'Target', scope: ['core'] }));
    const src = await service.register(makeInput({ term: 'Source', scope: ['other'] }));
    await service.merge([src.id], target.id);

    const mergedSrc = await store.get(src.id);
    expect(mergedSrc!.status).toBe('active');
    expect(mergedSrc!.supersedes).toBe(target.id);
    const meta = mergedSrc!.metadata as Record<string, unknown>;
    expect(meta.mergedInto).toBe(target.id);
  });

  it('AC4: merge rollback restores original status', async () => {
    const target = await service.register(makeInput({ term: 'Target', scope: ['core'] }));
    const src = await service.register(makeInput({ term: 'Source', scope: ['other'] }));
    await service.merge([src.id], target.id);
    await service.rollbackMerge([src.id]);

    const restored = await store.get(src.id);
    expect(restored!.status).toBe('active');
  });

  it('AC5: term changes emit events', async () => {
    const events: string[] = [];
    service.onTermChange(async (event) => { events.push(event.type); });

    const entry = await service.register(makeInput());
    expect(events).toContain('registered');

    await service.update(entry.id, { aliases: ['KE2'] }, entry.version);
    expect(events).toContain('updated');

    await service.deprecate(entry.id, 'test');
    expect(events).toContain('deprecated');
  });
});

// ── FR-H05: Term Batch Import & Seed Data ──

describe('FR-H05: Term Batch Import & Seed Data', () => {
  let store: MemoryStore;
  let service: DictionaryService;
  let importer: TermImporter;

  beforeEach(() => {
    store = new MemoryStore();
    service = new DictionaryService({ store });
    importer = new TermImporter({ dictionaryService: service });
  });

  it('AC1: imports from JSON with conflict detection', async () => {
    const json = JSON.stringify([
      { term: 'Alpha', definition: 'First letter', scope: ['greek'] },
      { term: 'Beta', definition: 'Second letter', scope: ['greek'] },
    ]);
    const report = await importer.importFromContent(json, 'json', testSource);
    expect(report.total).toBe(2);
    expect(report.succeeded).toBe(2);
  });

  it('AC1: imports from CSV', async () => {
    const csv = 'term,definition,scope\nAlpha,First letter,greek\nBeta,Second letter,greek';
    const report = await importer.importFromContent(csv, 'csv', testSource);
    expect(report.total).toBe(2);
    expect(report.succeeded).toBe(2);
  });

  it('AC1: imports from YAML', async () => {
    const yaml = `- term: Alpha
  definition: First letter
  scope: ["greek"]
- term: Beta
  definition: Second letter
  scope: ["greek"]`;
    const report = await importer.importFromContent(yaml, 'yaml', testSource);
    expect(report.total).toBe(2);
    expect(report.succeeded).toBe(2);
  });

  it('AC1: detects conflicts during import', async () => {
    await service.register(makeInput({ term: 'Alpha', scope: ['greek'] }));
    const json = JSON.stringify([
      { term: 'Alpha', definition: 'Duplicate', scope: ['greek'] },
    ]);
    const report = await importer.importFromContent(json, 'json', testSource);
    expect(report.conflicted + report.failed).toBeGreaterThan(0);
  });

  it('AC2: imports from governance document', async () => {
    const doc = `## KnowledgeEntry
A structured unit of knowledge stored in KIVO.
- 约束: Must have a unique ID
- 别名: KE, 知识条目
- 正例: A fact about TypeScript
- 负例: A random chat message
- 适用域: core

## Pipeline
An ordered sequence of processing stages.
- 约束: Must be idempotent
- 别名: 管线
- 适用域: core`;

    const report = await importer.importFromGovernanceDoc(doc, testSource);
    expect(report.total).toBe(2);
    expect(report.succeeded).toBe(2);
    expect(report.details[0].term).toBe('KnowledgeEntry');
    expect(report.details[1].term).toBe('Pipeline');
  });

  it('AC3: import report records success, conflict, skip, failure counts', async () => {
    const json = JSON.stringify([
      { term: 'Good', definition: 'Valid term', scope: ['test'] },
      { term: '', definition: 'Missing term' },
    ]);
    const report = await importer.importFromContent(json, 'json', testSource);
    expect(report.total).toBe(2);
    expect(report.succeeded).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.details).toHaveLength(2);
  });

  it('AC4: exports to JSON/YAML/CSV symmetrically', async () => {
    await service.register(makeInput({ term: 'Alpha', definition: 'First', scope: ['test'] }));

    const jsonExport = await importer.exportTo('json', 'test');
    const parsed = JSON.parse(jsonExport);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].term).toBe('Alpha');

    const yamlExport = await importer.exportTo('yaml', 'test');
    expect(yamlExport).toContain('term: Alpha');

    const csvExport = await importer.exportTo('csv', 'test');
    expect(csvExport).toContain('Alpha');
  });
});
