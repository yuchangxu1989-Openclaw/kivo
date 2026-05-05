import { describe, expect, it, beforeEach } from 'vitest';
import { AssociationDiscovery } from '../association-discovery.js';
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

class FakeRepository {
  private entries: KnowledgeEntry[] = [];
  add(entry: KnowledgeEntry) { this.entries.push(entry); }
  async findAll(): Promise<KnowledgeEntry[]> { return [...this.entries]; }
}

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

  describe('P1-2: maxScanEntries limits iteration', () => {
    it('limits scan set when entries exceed maxScanEntries', async () => {
      const target = makeEntry({ id: 'target', domain: 'alpha', content: 'unique content about testing frameworks' });
      for (let i = 0; i < 50; i++) {
        repo.add(makeEntry({ id: `e${i}`, domain: i < 10 ? 'alpha' : 'beta' }));
      }
      repo.add(target);

      const result = await discovery.discoverForEntry(target, { maxScanEntries: 15 });
      expect(result.length).toBeLessThanOrEqual(20);
    });

    it('prioritizes same-domain entries', async () => {
      const target = makeEntry({
        id: 'target', domain: 'alpha',
        content: 'Entry entry-1 is referenced here and also Entry entry-21',
      });
      for (let i = 1; i <= 20; i++) {
        repo.add(makeEntry({ id: `entry-${i}`, domain: 'alpha', title: `Entry entry-${i}` }));
      }
      for (let i = 21; i <= 40; i++) {
        repo.add(makeEntry({ id: `entry-${i}`, domain: 'beta', title: `Entry entry-${i}` }));
      }
      repo.add(target);

      const result = await discovery.discoverForEntry(target, { maxScanEntries: 25 });
      const domains = new Set<string>();
      for (const c of result) {
        const entry = (await repo.findAll()).find(e => e.id === c.targetId);
        if (entry) domains.add(entry.domain!);
      }
      expect(domains.has('alpha')).toBe(true);
    });
  });

  describe('P1-3: detectDependsOn short title filtering', () => {
    it('rejects titles shorter than 5 characters', async () => {
      const short = makeEntry({ id: 'short', title: 'API', domain: 'dev' });
      const entry = makeEntry({ id: 'main', content: 'We use the API for everything', domain: 'dev' });
      repo.add(short);
      repo.add(entry);

      const result = await discovery.discoverForEntry(entry, { similarityThreshold: 0 });
      const dependsOn = result.filter(c => c.type === 'depends_on' && c.targetId === 'short');
      expect(dependsOn).toEqual([]);
    });

    it('rejects stop-word titles', async () => {
      const config = makeEntry({ id: 'cfg', title: 'config', domain: 'dev' });
      const entry = makeEntry({ id: 'main', content: 'Check the config settings', domain: 'dev' });
      repo.add(config);
      repo.add(entry);

      const result = await discovery.discoverForEntry(entry, { similarityThreshold: 0 });
      const dependsOn = result.filter(c => c.type === 'depends_on' && c.targetId === 'cfg');
      expect(dependsOn).toEqual([]);
    });

    it('accepts sufficiently long non-stop-word titles', async () => {
      const target = makeEntry({ id: 'auth', title: 'authentication flow', domain: 'dev' });
      const entry = makeEntry({ id: 'main', content: 'The authentication flow handles login', domain: 'dev' });
      repo.add(target);
      repo.add(entry);

      const result = await discovery.discoverForEntry(entry, { similarityThreshold: 0 });
      const dependsOn = result.filter(c => c.type === 'depends_on' && c.targetId === 'auth');
      expect(dependsOn.length).toBe(1);
    });
  });
});

