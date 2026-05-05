import type { Association, AssociationFilter } from './association-types.js';

export class AssociationStore {
  private readonly associations = new Map<string, Association>();
  private readonly sourceIndex = new Map<string, Set<string>>();
  private readonly targetIndex = new Map<string, Set<string>>();

  add(association: Association): Association {
    const normalized = this.normalizeAssociation(association);
    const key = this.makeKey(normalized.sourceId, normalized.targetId);
    const previous = this.associations.get(key);

    if (previous) {
      this.detachIndexes(key, previous);
    }

    this.associations.set(key, normalized);
    this.attachIndexes(key, normalized);
    return this.cloneAssociation(normalized);
  }

  remove(sourceId: string, targetId: string): boolean {
    const key = this.makeKey(sourceId, targetId);
    const existing = this.associations.get(key);
    if (!existing) {
      return false;
    }

    this.detachIndexes(key, existing);
    this.associations.delete(key);
    return true;
  }

  getBySource(sourceId: string, filter: AssociationFilter = {}): Association[] {
    const keys = this.sourceIndex.get(sourceId);
    if (!keys) {
      return [];
    }

    return Array.from(keys)
      .map((key) => this.associations.get(key))
      .filter((association): association is Association => association !== undefined)
      .filter((association) => this.matchesFilter(association, { ...filter, sourceId }))
      .map((association) => this.cloneAssociation(association));
  }

  getByTarget(targetId: string, filter: AssociationFilter = {}): Association[] {
    const keys = this.targetIndex.get(targetId);
    if (!keys) {
      return [];
    }

    return Array.from(keys)
      .map((key) => this.associations.get(key))
      .filter((association): association is Association => association !== undefined)
      .filter((association) => this.matchesFilter(association, { ...filter, targetId }))
      .map((association) => this.cloneAssociation(association));
  }

  findPath(sourceId: string, targetId: string, maxDepth = Infinity): Association[] {
    if (sourceId === targetId) {
      return [];
    }

    const depthLimit = Number.isFinite(maxDepth) ? Math.max(0, Math.floor(maxDepth)) : Infinity;
    if (depthLimit === 0) {
      return [];
    }

    type QueueNode = {
      entryId: string;
      path: Association[];
      depth: number;
    };

    const visited = new Set<string>([sourceId]);
    const queue: QueueNode[] = [{ entryId: sourceId, path: [], depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      if (current.depth >= depthLimit) {
        continue;
      }

      const nextAssociations = this.getBySource(current.entryId);
      for (const association of nextAssociations) {
        const nextPath = [...current.path, association];
        if (association.targetId === targetId) {
          return nextPath;
        }

        if (!visited.has(association.targetId)) {
          visited.add(association.targetId);
          queue.push({
            entryId: association.targetId,
            path: nextPath,
            depth: current.depth + 1,
          });
        }
      }
    }

    return [];
  }

  private normalizeAssociation(association: Association): Association {
    return {
      ...association,
      strength: this.normalizeStrength(association.strength),
      metadata: association.metadata ? { ...association.metadata } : undefined,
    };
  }

  private normalizeStrength(strength: number): number {
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw new Error('Association strength must be a finite number between 0 and 1');
    }
    return strength;
  }

  private matchesFilter(association: Association, filter: AssociationFilter): boolean {
    if (filter.sourceId !== undefined && association.sourceId !== filter.sourceId) {
      return false;
    }

    if (filter.targetId !== undefined && association.targetId !== filter.targetId) {
      return false;
    }

    if (filter.type !== undefined) {
      const allowedTypes = Array.isArray(filter.type) ? filter.type : [filter.type];
      if (!allowedTypes.includes(association.type)) {
        return false;
      }
    }

    if (filter.minStrength !== undefined && association.strength < filter.minStrength) {
      return false;
    }

    return true;
  }

  private attachIndexes(key: string, association: Association): void {
    this.ensureIndex(this.sourceIndex, association.sourceId).add(key);
    this.ensureIndex(this.targetIndex, association.targetId).add(key);
  }

  private detachIndexes(key: string, association: Association): void {
    this.deleteFromIndex(this.sourceIndex, association.sourceId, key);
    this.deleteFromIndex(this.targetIndex, association.targetId, key);
  }

  private ensureIndex(index: Map<string, Set<string>>, id: string): Set<string> {
    let set = index.get(id);
    if (!set) {
      set = new Set<string>();
      index.set(id, set);
    }
    return set;
  }

  private deleteFromIndex(index: Map<string, Set<string>>, id: string, key: string): void {
    const set = index.get(id);
    if (!set) {
      return;
    }

    set.delete(key);
    if (set.size === 0) {
      index.delete(id);
    }
  }

  private cloneAssociation(association: Association): Association {
    return {
      ...association,
      metadata: association.metadata ? { ...association.metadata } : undefined,
    };
  }

  private makeKey(sourceId: string, targetId: string): string {
    return `${sourceId}::${targetId}`;
  }
}
