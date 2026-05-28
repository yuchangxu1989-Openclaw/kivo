import { describe, expect, it, beforeEach } from 'vitest';
import { AssociationDiscovery, cosineSimilarity } from '../association-discovery.js';
import { AssociationStore } from '../association-store.js';
import type { KnowledgeEntry, KnowledgeSource } from '../../types/index.js';

const testSource = (ref: string): KnowledgeSource => ({
  type: 'document',
  reference: ref,
  timestamp: new Date('2026-04-20T09:00:00.000Z'),
});

let idCounter = 0;
function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const id = overrides.id ?? `entry-${++idCounter}`;
  return {
    id, type: 'fact', title: `Entry ${id}`, content: 'some content here',
    summary: 'summary', source: testSource(`doc://${id}`), confidence: 0.9,
    status: 'active', tags: ['test'], domain: overrides.domain ?? 'default',
    createdAt: new Date('2026-04-10'), updatedAt: new Date('2026-04-10'), version: 1,
    ...overrides,
  };
}

/** Generate a random unit vector of given dimensions */
function randomVector(dims: number): Float32Array {
  const vec = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    vec[i] = Math.random() - 0.5;
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) vec[i] /= norm;
  return vec;
}

/** Create a vector similar to base with given target cosine similarity */
function similarVector(base: Float32Array, targetSim: number): Float32Array {
  const dims = base.length;
  const noise = randomVector(dims);
  // Mix base and noise to achieve approximate target similarity
  const alpha = targetSim;
  const beta = Math.sqrt(1 - targetSim * targetSim);
  const result = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    result[i] = alpha * base[i] + beta * noise[i];
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += result[i] * result[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) result[i] /= norm;
  return result;
}

class FakeRepository {
  private entries: KnowledgeEntry[] = [];
  add(entry: KnowledgeEntry) { this.entries.push(entry); }
  async findAll(): Promise<KnowledgeEntry[]> { return [...this.entries]; }
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 0, 0, 0]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('returns 0 for zero-length vectors', () => {
    const a = new Float32Array([]);
    const b = new Float32Array([]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 for zero-magnitude vector', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('handles mismatched lengths', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('AssociationDiscovery', () => {
  let repo: FakeRepository;
  let store: AssociationStore;
  let discovery: AssociationDiscovery;

  beforeEach(() => {
    idCounter = 0;
    repo = new FakeRepository();
    store = new AssociationStore();
    discovery = new AssociationDiscovery(repo as any, store);
  });

  describe('discoverForEntry', () => {
    it('returns empty when no embeddings provided', async () => {
      const entry = makeEntry({ id: 'a' });
      repo.add(entry);
      repo.add(makeEntry({ id: 'b' }));

      const result = await discovery.discoverForEntry(entry);
      expect(result).toEqual([]);
    });

    it('returns empty when source entry has no embedding', async () => {
      const entry = makeEntry({ id: 'a' });
      const other = makeEntry({ id: 'b' });
      repo.add(entry);
      repo.add(other);

      const embeddings = new Map<string, Float32Array>();
      embeddings.set('b', randomVector(512));

      const result = await discovery.discoverForEntry(entry, { embeddings });
      expect(result).toEqual([]);
    });

    it('skips entries without embeddings', async () => {
      const baseVec = randomVector(512);
      const entry = makeEntry({ id: 'a', domain: 'test' });
      const withEmbed = makeEntry({ id: 'b', domain: 'test' });
      const noEmbed = makeEntry({ id: 'c', domain: 'test' });
      repo.add(entry);
      repo.add(withEmbed);
      repo.add(noEmbed);

      const embeddings = new Map<string, Float32Array>();
      embeddings.set('a', baseVec);
      embeddings.set('b', similarVector(baseVec, 0.85));
      // 'c' has no embedding

      const result = await discovery.discoverForEntry(entry, { embeddings, similarityThreshold: 0.7 });
      expect(result.some(c => c.targetId === 'c')).toBe(false);
      expect(result.some(c => c.targetId === 'b')).toBe(true);
    });

    it('finds semantically similar entries above threshold', async () => {
      const baseVec = randomVector(512);
      const entry = makeEntry({ id: 'a', domain: 'dev' });
      const similar = makeEntry({ id: 'b', domain: 'dev' });
      const dissimilar = makeEntry({ id: 'c', domain: 'dev' });
      repo.add(entry);
      repo.add(similar);
      repo.add(dissimilar);

      const embeddings = new Map<string, Float32Array>();
      embeddings.set('a', baseVec);
      embeddings.set('b', similarVector(baseVec, 0.9)); // high similarity
      embeddings.set('c', randomVector(512)); // random = low similarity

      const result = await discovery.discoverForEntry(entry, { embeddings, similarityThreshold: 0.75 });
      expect(result.some(c => c.targetId === 'b')).toBe(true);
    });

    it('detects explicit supersedes', async () => {
      const baseVec = randomVector(512);
      const entry = makeEntry({ id: 'new', domain: 'dev', supersedes: 'old' } as any);
      const old = makeEntry({ id: 'old', domain: 'dev' });
      repo.add(entry);
      repo.add(old);

      const embeddings = new Map<string, Float32Array>();
      embeddings.set('new', baseVec);
      embeddings.set('old', similarVector(baseVec, 0.85));

      const result = await discovery.discoverForEntry(entry, { embeddings, similarityThreshold: 0.7 });
      const supersedes = result.filter(c => c.type === 'supersedes' && c.targetId === 'old');
      expect(supersedes.length).toBe(1);
      expect(supersedes[0].strength).toBe(0.95);
    });

    it('classifies high similarity same domain/type as conflicts', async () => {
      const baseVec = randomVector(512);
      const entry = makeEntry({ id: 'a', domain: 'dev', type: 'fact' });
      const other = makeEntry({ id: 'b', domain: 'dev', type: 'fact' });
      repo.add(entry);
      repo.add(other);

      const embeddings = new Map<string, Float32Array>();
      embeddings.set('a', baseVec);
      embeddings.set('b', similarVector(baseVec, 0.88));

      const result = await discovery.discoverForEntry(entry, { embeddings, similarityThreshold: 0.75 });
      const conflicts = result.filter(c => c.type === 'conflicts');
      expect(conflicts.length).toBe(1);
    });

    it('classifies cross-domain similarity as depends_on', async () => {
      const baseVec = randomVector(512);
      const entry = makeEntry({ id: 'a', domain: 'frontend' });
      const other = makeEntry({ id: 'b', domain: 'backend' });
      repo.add(entry);
      repo.add(other);

      const embeddings = new Map<string, Float32Array>();
      embeddings.set('a', baseVec);
      embeddings.set('b', similarVector(baseVec, 0.8));

      const result = await discovery.discoverForEntry(entry, { embeddings, similarityThreshold: 0.75 });
      const deps = result.filter(c => c.type === 'depends_on');
      expect(deps.length).toBe(1);
    });

    it('autoCommit stores associations', async () => {
      const baseVec = randomVector(512);
      const entry = makeEntry({ id: 'a', domain: 'dev' });
      const other = makeEntry({ id: 'b', domain: 'dev' });
      repo.add(entry);
      repo.add(other);

      const embeddings = new Map<string, Float32Array>();
      embeddings.set('a', baseVec);
      embeddings.set('b', similarVector(baseVec, 0.85));

      await discovery.discoverForEntry(entry, { embeddings, similarityThreshold: 0.75, autoCommit: true });
      const stored = store.getBySource('a');
      expect(stored.length).toBeGreaterThan(0);
    });
  });

  describe('discoverAll', () => {
    it('returns empty when no embeddings', async () => {
      repo.add(makeEntry({ id: 'a' }));
      repo.add(makeEntry({ id: 'b' }));

      const result = await discovery.discoverAll();
      expect(result).toEqual([]);
    });

    it('finds all pairwise associations above threshold', async () => {
      const baseVec = randomVector(512);
      const a = makeEntry({ id: 'a', domain: 'dev' });
      const b = makeEntry({ id: 'b', domain: 'dev' });
      const c = makeEntry({ id: 'c', domain: 'dev' });
      repo.add(a);
      repo.add(b);
      repo.add(c);

      const embeddings = new Map<string, Float32Array>();
      embeddings.set('a', baseVec);
      embeddings.set('b', similarVector(baseVec, 0.9));
      embeddings.set('c', randomVector(512)); // dissimilar

      const result = await discovery.discoverAll({ embeddings, similarityThreshold: 0.75 });
      // a-b should be found, a-c and b-c likely not (random vectors)
      expect(result.some(c => (c.sourceId === 'a' && c.targetId === 'b') || (c.sourceId === 'b' && c.targetId === 'a'))).toBe(true);
    });

    it('respects maxCandidates', async () => {
      const baseVec = randomVector(512);
      const entries: KnowledgeEntry[] = [];
      const embeddings = new Map<string, Float32Array>();

      for (let i = 0; i < 10; i++) {
        const e = makeEntry({ id: `e${i}`, domain: 'dev' });
        entries.push(e);
        repo.add(e);
        embeddings.set(`e${i}`, similarVector(baseVec, 0.85 + Math.random() * 0.1));
      }

      const result = await discovery.discoverAll({ embeddings, similarityThreshold: 0.75, maxCandidates: 5 });
      expect(result.length).toBeLessThanOrEqual(5);
    });
  });
});
