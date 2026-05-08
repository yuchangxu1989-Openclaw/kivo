import type { KnowledgeEntry } from '../types/index.js';
import type { KnowledgeRepository } from '../repository/index.js';
import type { SearchResult } from '../repository/storage-provider.js';
import type { AssociationType } from './association-types.js';
import { AssociationStore } from './association-store.js';

export interface EnhancedSearchResult extends SearchResult {
  associatedEntries: AssociatedEntry[];
}

export interface AssociatedEntry {
  entry: KnowledgeEntry;
  viaType: AssociationType;
  viaStrength: number;
  direction: 'outgoing' | 'incoming';
}

export interface EnhancementOptions {
  maxAssociatedPerResult?: number;
  minAssociationStrength?: number;
  includeTypes?: AssociationType[];
  maxDepth?: number;
}

export class AssociationEnhancedRetrieval {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly store: AssociationStore
  ) {}

  async enhance(
    results: SearchResult[],
    options: EnhancementOptions = {}
  ): Promise<EnhancedSearchResult[]> {
    const maxPerResult = options.maxAssociatedPerResult ?? 5;
    const minStrength = options.minAssociationStrength ?? 0.3;
    const includeTypes = options.includeTypes;
    const seenIds = new Set(results.map((r) => r.entry.id));

    const enhanced: EnhancedSearchResult[] = [];

    for (const result of results) {
      const associated = await this.findAssociated(
        result.entry.id,
        seenIds,
        minStrength,
        includeTypes,
        maxPerResult
      );
      enhanced.push({ ...result, associatedEntries: associated });
      for (const a of associated) {
        seenIds.add(a.entry.id);
      }
    }

    return enhanced;
  }

  async expandResults(
    results: SearchResult[],
    options: EnhancementOptions = {}
  ): Promise<SearchResult[]> {
    const enhanced = await this.enhance(results, options);
    const seen = new Set(results.map((r) => r.entry.id));
    const expanded: SearchResult[] = [...results];

    for (const er of enhanced) {
      for (const assoc of er.associatedEntries) {
        if (!seen.has(assoc.entry.id)) {
          seen.add(assoc.entry.id);
          expanded.push({
            entry: assoc.entry,
            score: er.score * assoc.viaStrength * 0.8,
          });
        }
      }
    }

    return expanded.sort((a, b) => b.score - a.score);
  }
  private async findAssociated(
    entryId: string,
    exclude: Set<string>,
    minStrength: number,
    includeTypes: AssociationType[] | undefined,
    limit: number
  ): Promise<AssociatedEntry[]> {
    const outgoing = this.store
      .getBySource(entryId, { minStrength })
      .filter((a) => !exclude.has(a.targetId))
      .filter((a) => !includeTypes || includeTypes.includes(a.type));

    const incoming = this.store
      .getByTarget(entryId, { minStrength })
      .filter((a) => !exclude.has(a.sourceId))
      .filter((a) => !includeTypes || includeTypes.includes(a.type));

    const candidates: { id: string; type: AssociationType; strength: number; direction: 'outgoing' | 'incoming' }[] = [];
    for (const a of outgoing) {
      candidates.push({ id: a.targetId, type: a.type, strength: a.strength, direction: 'outgoing' });
    }
    for (const a of incoming) {
      candidates.push({ id: a.sourceId, type: a.type, strength: a.strength, direction: 'incoming' });
    }

    candidates.sort((a, b) => b.strength - a.strength);
    const top = candidates.slice(0, limit);

    const associated: AssociatedEntry[] = [];
    for (const c of top) {
      const entry = await this.repository.findById(c.id);
      if (entry) {
        associated.push({
          entry,
          viaType: c.type,
          viaStrength: c.strength,
          direction: c.direction,
        });
      }
    }

    return associated;
  }
}
