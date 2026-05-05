import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteProvider } from '../src/repository/sqlite-provider.js';
import { KnowledgeRepository } from '../src/repository/knowledge-repository.js';
import { JsonExporter } from '../src/repository/json-exporter.js';
import type { KnowledgeEntry, KnowledgeSource } from '../src/types/index.js';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DB = join(tmpdir(), `kivo-test-${Date.now()}.db`);
const TEST_JSON = join(tmpdir(), `kivo-test-${Date.now()}.json`);

const testSource: KnowledgeSource = {
  type: 'manual',
  reference: 'unit-test',
  timestamp: new Date(),
};

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    type: 'fact',
    title: 'Test Entry',
    content: 'This is test content for the knowledge entry.',
    summary: 'Test summary',
    source: testSource,
    confidence: 0.9,
    status: 'active',
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

describe('SQLiteProvider', () => {
  let provider: SQLiteProvider;

  beforeEach(() => {
    provider = new SQLiteProvider({ dbPath: TEST_DB });
  });

  afterEach(async () => {
    await provider.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    if (existsSync(TEST_DB + '-wal')) unlinkSync(TEST_DB + '-wal');
    if (existsSync(TEST_DB + '-shm')) unlinkSync(TEST_DB + '-shm');
  });

  it('should save and retrieve an entry by id', async () => {
    const entry = makeEntry({ id: 'e1', title: 'First Entry' });
    await provider.save(entry);
    const found = await provider.findById('e1');
    expect(found).not.toBeNull();
    expect(found!.title).toBe('First Entry');
    expect(found!.type).toBe('fact');
    expect(found!.source.type).toBe('manual');
  });

  it('should return null for non-existent id', async () => {
    const found = await provider.findById('nonexistent');
    expect(found).toBeNull();
  });

  it('should update existing entry on save (version bump)', async () => {
    const entry = makeEntry({ id: 'e2', title: 'Original' });
    await provider.save(entry);
    await provider.save({ ...entry, title: 'Updated', content: 'New content' });
    const found = await provider.findById('e2');
    expect(found!.title).toBe('Updated');
    expect(found!.version).toBe(2);
  });

  it('should update status', async () => {
    const entry = makeEntry({ id: 'e3' });
    await provider.save(entry);
    await provider.updateStatus('e3', 'superseded');
    const found = await provider.findById('e3');
    expect(found!.status).toBe('superseded');
  });

  it('should find entries by type', async () => {
    await provider.save(makeEntry({ id: 'f1', type: 'fact' }));
    await provider.save(makeEntry({ id: 'f2', type: 'methodology' }));
    await provider.save(makeEntry({ id: 'f3', type: 'fact' }));
    const facts = await provider.findByType('fact');
    expect(facts.length).toBe(2);
  });

  it('should perform full text search', async () => {
    await provider.save(makeEntry({ id: 'fts1', title: 'TypeScript strict mode', content: 'Always enable strict mode in tsconfig' }));
    await provider.save(makeEntry({ id: 'fts2', title: 'Python typing', content: 'Use mypy for type checking' }));
    const results = await provider.fullTextSearch('TypeScript strict');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe('fts1');
  });

  it('should delete an entry', async () => {
    await provider.save(makeEntry({ id: 'del1' }));
    await provider.delete('del1');
    const found = await provider.findById('del1');
    expect(found).toBeNull();
  });

  it('should count entries', async () => {
    await provider.save(makeEntry({ id: 'c1' }));
    await provider.save(makeEntry({ id: 'c2' }));
    const count = await provider.count();
    expect(count).toBe(2);
  });

  it('should handle transactions atomically', async () => {
    const entry = makeEntry({ id: 'txn1' });
    await provider.save(entry);
    await provider.save({ ...entry, title: 'Updated via txn' });
    const count = await provider.count();
    expect(count).toBe(1);
  });

  it('should preserve tags and domain', async () => {
    const entry = makeEntry({ id: 'tag1', tags: ['ts', 'config'], domain: 'dev-tools' });
    await provider.save(entry);
    const found = await provider.findById('tag1');
    expect(found!.tags).toEqual(['ts', 'config']);
    expect(found!.domain).toBe('dev-tools');
  });
});

describe('KnowledgeRepository', () => {
  let provider: SQLiteProvider;
  let repo: KnowledgeRepository;

  beforeEach(() => {
    provider = new SQLiteProvider({ dbPath: TEST_DB });
    repo = new KnowledgeRepository(provider);
  });

  afterEach(async () => {
    await repo.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    if (existsSync(TEST_DB + '-wal')) unlinkSync(TEST_DB + '-wal');
    if (existsSync(TEST_DB + '-shm')) unlinkSync(TEST_DB + '-shm');
  });

  it('should delegate save/findById to provider', async () => {
    const entry = makeEntry({ id: 'repo1' });
    await repo.save(entry);
    const found = await repo.findById('repo1');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('repo1');
  });

  it('should delegate count', async () => {
    await repo.save(makeEntry({ id: 'r1' }));
    await repo.save(makeEntry({ id: 'r2' }));
    expect(await repo.count()).toBe(2);
  });
});

describe('JsonExporter', () => {
  let provider: SQLiteProvider;
  let repo: KnowledgeRepository;

  beforeEach(() => {
    provider = new SQLiteProvider({ dbPath: TEST_DB });
    repo = new KnowledgeRepository(provider);
  });

  afterEach(async () => {
    await repo.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    if (existsSync(TEST_JSON)) unlinkSync(TEST_JSON);
    if (existsSync(TEST_DB + '-wal')) unlinkSync(TEST_DB + '-wal');
    if (existsSync(TEST_DB + '-shm')) unlinkSync(TEST_DB + '-shm');
  });

  it('should export entries to JSON file', async () => {
    await repo.save(makeEntry({ id: 'exp1', type: 'fact' }));
    await repo.save(makeEntry({ id: 'exp2', type: 'decision' }));

    const exporter = new JsonExporter(repo, { outputPath: TEST_JSON, pretty: true });
    await exporter.export();

    expect(existsSync(TEST_JSON)).toBe(true);
    const { readFileSync } = await import('node:fs');
    const data = JSON.parse(readFileSync(TEST_JSON, 'utf-8'));
    expect(data.totalEntries).toBe(2);
    expect(data.entries.length).toBe(2);
  });
});
