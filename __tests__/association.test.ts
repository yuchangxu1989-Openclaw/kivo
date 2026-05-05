import { beforeEach, describe, expect, it } from 'vitest';
import { AssociationStore } from '../src/association/index.js';
import type { Association } from '../src/association/index.js';

function makeAssociation(overrides: Partial<Association> = {}): Association {
  return {
    sourceId: 'entry-a',
    targetId: 'entry-b',
    type: 'supplements',
    strength: 0.8,
    metadata: { reason: 'test' },
    ...overrides,
  };
}

describe('AssociationStore', () => {
  let store: AssociationStore;

  beforeEach(() => {
    store = new AssociationStore();
  });

  it('adds, replaces, and removes associations', () => {
    const created = store.add(makeAssociation());
    expect(created).toEqual(makeAssociation());

    const updated = store.add(
      makeAssociation({
        type: 'supersedes',
        strength: 0.95,
        metadata: { reason: 'newer version' },
      })
    );

    const bySource = store.getBySource('entry-a');
    expect(bySource).toHaveLength(1);
    expect(bySource[0]).toEqual(updated);

    expect(store.remove('entry-a', 'entry-b')).toBe(true);
    expect(store.remove('entry-a', 'entry-b')).toBe(false);
    expect(store.getBySource('entry-a')).toEqual([]);
    expect(store.getByTarget('entry-b')).toEqual([]);
  });

  it('queries by source and target with type and strength filters', () => {
    store.add(makeAssociation({ sourceId: 'entry-a', targetId: 'entry-b', type: 'supplements', strength: 0.4 }));
    store.add(makeAssociation({ sourceId: 'entry-a', targetId: 'entry-c', type: 'depends_on', strength: 0.9 }));
    store.add(makeAssociation({ sourceId: 'entry-d', targetId: 'entry-c', type: 'conflicts', strength: 0.7 }));
    store.add(makeAssociation({ sourceId: 'entry-e', targetId: 'entry-c', type: 'supplements', strength: 0.6 }));

    const fromSource = store.getBySource('entry-a');
    expect(fromSource).toHaveLength(2);
    expect(fromSource.map((association) => association.targetId)).toEqual(['entry-b', 'entry-c']);

    const dependsOnOnly = store.getBySource('entry-a', { type: 'depends_on' });
    expect(dependsOnOnly).toHaveLength(1);
    expect(dependsOnOnly[0].targetId).toBe('entry-c');

    const strongOnly = store.getBySource('entry-a', { minStrength: 0.5 });
    expect(strongOnly).toHaveLength(1);
    expect(strongOnly[0].type).toBe('depends_on');

    const byTarget = store.getByTarget('entry-c');
    expect(byTarget).toHaveLength(3);
    expect(byTarget.map((association) => association.sourceId)).toEqual(['entry-a', 'entry-d', 'entry-e']);

    const filteredTarget = store.getByTarget('entry-c', {
      type: ['depends_on', 'conflicts'],
      minStrength: 0.7,
    });
    expect(filteredTarget).toHaveLength(2);
    expect(filteredTarget.map((association) => association.type)).toEqual(['depends_on', 'conflicts']);
  });

  it('finds BFS path between entries', () => {
    store.add(makeAssociation({ sourceId: 'entry-a', targetId: 'entry-b', type: 'supplements', strength: 0.6 }));
    store.add(makeAssociation({ sourceId: 'entry-b', targetId: 'entry-c', type: 'depends_on', strength: 0.8 }));
    store.add(makeAssociation({ sourceId: 'entry-c', targetId: 'entry-d', type: 'supersedes', strength: 0.9 }));
    store.add(makeAssociation({ sourceId: 'entry-a', targetId: 'entry-e', type: 'supplements', strength: 0.5 }));
    store.add(makeAssociation({ sourceId: 'entry-e', targetId: 'entry-f', type: 'depends_on', strength: 0.7 }));

    const path = store.findPath('entry-a', 'entry-d');
    expect(path).toHaveLength(3);
    expect(path.map((association) => `${association.sourceId}->${association.targetId}`)).toEqual([
      'entry-a->entry-b',
      'entry-b->entry-c',
      'entry-c->entry-d',
    ]);
  });

  it('returns empty results when no association or path matches', () => {
    store.add(makeAssociation({ sourceId: 'entry-a', targetId: 'entry-b', type: 'supplements', strength: 0.6 }));
    store.add(makeAssociation({ sourceId: 'entry-b', targetId: 'entry-c', type: 'depends_on', strength: 0.8 }));

    expect(store.getBySource('missing')).toEqual([]);
    expect(store.getByTarget('missing')).toEqual([]);
    expect(store.getBySource('entry-a', { type: 'conflicts' })).toEqual([]);
    expect(store.findPath('entry-a', 'entry-z')).toEqual([]);
    expect(store.findPath('entry-a', 'entry-c', 1)).toEqual([]);
    expect(store.findPath('entry-a', 'entry-a')).toEqual([]);
  });

  it('isolates returned associations from internal state and validates strength bounds', () => {
    const saved = store.add(makeAssociation({ metadata: { reason: 'original' } }));
    saved.metadata = { reason: 'mutated outside' };

    const fetched = store.getBySource('entry-a')[0];
    expect(fetched.metadata).toEqual({ reason: 'original' });

    expect(() => store.add(makeAssociation({ sourceId: 'entry-x', targetId: 'entry-y', strength: 1.1 }))).toThrow(
      'Association strength must be a finite number between 0 and 1'
    );
  });
});
