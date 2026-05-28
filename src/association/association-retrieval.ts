import type { KnowledgeEntry } from '../types/index.js';
import type { KnowledgeRepository } from '../repository/index.js';
import type { SearchResult } from '../repository/storage-provider.js';
import type { AssociationType } from './association-types.js';
import { AssociationStore } from './association-store.js';
import { buildSnapshot, type KnowledgeGraphSnapshot } from './knowledge-graph.js';
import { computeDynamicThreshold, computeP75Weight, annotateWeights } from './graph-insights.js';

export interface EnhancedSearchResult extends SearchResult {
  associatedEntries: AssociatedEntry[];
  sourcePath?: 'vector_match' | 'graph_expansion';
}

export interface AssociatedEntry {
  entry: KnowledgeEntry;
  viaType: AssociationType;
  viaStrength: number;
  direction: 'outgoing' | 'incoming';
  weightScore: number;
  weightTier: 'normal' | 'downweighted';
}

export interface EnhancementOptions {
  maxAssociatedPerResult?: number;
  minAssociationStrength?: number;
  includeTypes?: AssociationType[];
  maxDepth?: number;
  /** FR-FIX-09: When provided, uses dynamic threshold from graph density */
  graphSnapshot?: KnowledgeGraphSnapshot;
  /** FR-G05: Optional edge weight distribution for dynamic P75 threshold. */
  graphWeightDistribution?: number[];
}

function percentile(values: number[], p: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
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
    // FR-FIX-09 AC2 + FR-G05 AC5: Use dynamic P75 edge weight as the default
    // graph expansion threshold when no explicit config is provided.
    const graphSnapshot = options.graphSnapshot ?? buildSnapshot([], this.store.listAll(), new Date());
    const p75Threshold = percentile(options.graphWeightDistribution ?? this.store.listAll().map(a => a.strength), 0.75);
    const minStrength = options.minAssociationStrength ?? p75Threshold ?? computeDynamicThreshold(graphSnapshot);
    const includeTypes = options.includeTypes;
    const seenIds = new Set(results.map((r) => r.entry.id));
    const p75 = computeP75Weight(graphSnapshot);

    const enhanced: EnhancedSearchResult[] = [];

    for (const result of results) {
      const associated = await this.findAssociated(
        result.entry.id,
        seenIds,
        minStrength,
        includeTypes,
        maxPerResult
      );
      // FR-FIX-09 AC3: Down-weight associations below P75
      const annotated = annotateWeights(
        associated.map(a => ({ entryId: a.entry.id, weight: a.viaStrength })),
        p75
      );
      for (let i = 0; i < associated.length; i++) {
        const ann = annotated.find(a => a.entryId === associated[i].entry.id);
        if (ann) {
          associated[i] = {
            ...associated[i],
            viaStrength: ann.weight,
            weightScore: ann.weight,
            weightTier: ann.belowP75 ? 'downweighted' : 'normal',
          };
        }
      }
      enhanced.push({ ...result, sourcePath: 'vector_match', associatedEntries: associated });
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
  /**
   * FR-G05: Expand a set of hit entry IDs by traversing one-hop graph neighbors.
   * Returns the original hits merged with graph-expanded entries, sorted by relevance.
   */
  async expandByGraph(
    hitIds: string[],
    options: EnhancementOptions = {}
  ): Promise<SearchResult[]> {
    const maxPerHit = options.maxAssociatedPerResult ?? 20;
    const graphSnapshot = options.graphSnapshot ?? buildSnapshot([], this.store.listAll(), new Date());
    const p75Threshold = percentile(options.graphWeightDistribution ?? this.store.listAll().map(a => a.strength), 0.75);
    const minStrength = options.minAssociationStrength ?? p75Threshold ?? computeDynamicThreshold(graphSnapshot);
    const includeTypes = options.includeTypes;

    const seenIds = new Set(hitIds);
    const originalEntries: SearchResult[] = [];
    const expandedEntries: SearchResult[] = [];

    // Resolve original hit entries
    for (const id of hitIds) {
      const entry = await this.repository.findById(id);
      if (entry) {
        originalEntries.push({ entry, score: 1.0 });
      }
    }

    // For each hit, find one-hop graph neighbors
    for (const id of hitIds) {
      const neighbors = await this.findAssociated(
        id,
        seenIds,
        minStrength,
        includeTypes,
        maxPerHit
      );

      for (const neighbor of neighbors) {
        if (!seenIds.has(neighbor.entry.id)) {
          seenIds.add(neighbor.entry.id);
          // Score derived from association strength, discounted; source path is
          // available to injection formatters/loggers via the graph_expansion tag.
          expandedEntries.push({
            entry: neighbor.entry,
            score: neighbor.viaStrength * 0.8,
            sourcePath: 'graph_expansion',
          } as SearchResult & { sourcePath: 'graph_expansion' });
        }
      }
    }

    // Merge: originals first (score=1.0), then expanded sorted by score desc
    expandedEntries.sort((a, b) => b.score - a.score);
    return [...originalEntries, ...expandedEntries];
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
          weightScore: c.strength,
          weightTier: 'normal',
        });
      }
    }

    return associated;
  }
}
