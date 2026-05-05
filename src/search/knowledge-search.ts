import type { KnowledgeEntry, KnowledgeType, EntryStatus } from '../types/index.js';
import type { KnowledgeStore } from '../storage/knowledge-store.js';
import { keywordSearch } from './keyword-search.js';
import type {
  EmbeddingAdapter,
  SearchMode,
  SearchOptions,
  SearchQuery,
  SearchResult,
} from './search-types.js';
import { cosineSimilarity } from '../utils/math.js';
import type { AssociationStore } from '../association/association-store.js';
import type { DomainGoal } from '../domain-goal/domain-goal-types.js';
import { boostByDomainGoal } from '../domain-goal/domain-goal-constraints.js';

export interface KnowledgeSearchOptions {
  associationStore?: AssociationStore;
  includeAssociated?: boolean;
  maxAssociatedDepth?: number;
  domainGoalStore?: {
    get(domainId: string): DomainGoal | null;
  };
}

export class KnowledgeSearch {

  constructor(
    private readonly store: KnowledgeStore,
    private readonly embeddingAdapter: EmbeddingAdapter = new MockEmbeddingAdapter(),
    private readonly options: KnowledgeSearchOptions = {},
  ) {}

  async search(query: SearchQuery | string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery.text) {
      return [];
    }

    const candidates = await this.loadCandidates(options);
    if (candidates.length === 0) {
      return [];
    }

    let mode = normalizedQuery.mode ?? 'hybrid';

    // If embedding is unavailable, use keyword-only
    if (mode !== 'keyword') {
      try {
        await this.embeddingAdapter.embed('test');
      } catch {
        mode = 'keyword';
      }
    }

    const results = await this.rank(candidates, normalizedQuery.text, mode);
    const minRelevance = options.minRelevance ?? 0;
    let filtered = results.filter((result) => result.relevance >= minRelevance);

    // FR-B03 AC3: Enhance results with associated entries
    if (this.options.includeAssociated && this.options.associationStore && filtered.length > 0) {
      filtered = await this.enrichWithAssociations(filtered, candidates);
    }

    filtered = this.applyDomainGoalBoost(filtered, options.domain);

    const offset = normalizeOffset(options.offset);
    const limit = normalizeLimit(options.limit, filtered.length);
    return filtered.slice(offset, offset + limit);
  }

  /**
   * FR-B03 AC3: Enrich search results with associated entries to improve completeness.
   */
  private async enrichWithAssociations(
    results: SearchResult[],
    allCandidates: KnowledgeEntry[],
  ): Promise<SearchResult[]> {
    const store = this.options.associationStore!;
    const resultIds = new Set(results.map((r) => r.entry.id));
    const candidateMap = new Map(allCandidates.map((e) => [e.id, e]));
    const enriched = [...results];

    for (const result of results.slice(0, 5)) {
      const associations = store.getBySource(result.entry.id);
      for (const assoc of associations) {
        if (resultIds.has(assoc.targetId)) continue;
        const entry = candidateMap.get(assoc.targetId);
        if (!entry) continue;

        resultIds.add(assoc.targetId);
        enriched.push({
          entry,
          relevance: result.relevance * assoc.strength * 0.8,
          mode: 'hybrid',
          matchedTerms: [],
        });
      }
    }

    enriched.sort((a, b) => b.relevance - a.relevance);
    return enriched;
  }

  private async loadCandidates(options: SearchOptions): Promise<KnowledgeEntry[]> {
    const response = await this.store.query({
      type: normalizeArray<KnowledgeType>(options.type),
      domain: normalizeArray<string>(options.domain),
      status: normalizeArray<EntryStatus>(options.status),
      source: normalizeArray<string>(options.source),
      createdAt: options.createdAt,
      updatedAt: options.updatedAt,
    });

    return response.items;
  }

  private async rank(
    entries: KnowledgeEntry[],
    query: string,
    mode: SearchMode
  ): Promise<SearchResult[]> {
    const keywordResults = mode === 'semantic'
      ? new Map<string, { score: number; matchedTerms: string[] }>()
      : new Map(
          keywordSearch(query, entries).map((result) => [
            result.entry.id,
            { score: result.score, matchedTerms: result.matchedTerms },
          ])
        );

    const semanticResults = mode === 'keyword'
      ? new Map<string, number>()
      : await this.buildSemanticScoreMap(entries, query);

    const combined = entries
      .map((entry) => {
        const keyword = keywordResults.get(entry.id);
        const semantic = semanticResults.get(entry.id) ?? 0;
        const relevance = computeRelevance(mode, keyword?.score ?? 0, semantic);

        if (relevance <= 0) {
          return null;
        }

        return {
          entry,
          relevance,
          mode,
          matchedTerms: keyword?.matchedTerms,
        };
      })
      .filter(Boolean) as SearchResult[];

    combined.sort((a, b) => b.relevance - a.relevance || b.entry.updatedAt.getTime() - a.entry.updatedAt.getTime());

    return combined;
  }

  private async buildSemanticScoreMap(entries: KnowledgeEntry[], query: string): Promise<Map<string, number>> {
    const queryVector = await this.embeddingAdapter.embed(query);
    const entryVectors = await Promise.all(
      entries.map((entry) => this.embeddingAdapter.embed(buildSemanticText(entry)))
    );

    return new Map(
      entries.map((entry, index) => {
        const score = cosineSimilarity(queryVector, entryVectors[index]);
        const normalizedScore = Math.max(0, Math.min(1, (score + 1) / 2));
        return [entry.id, normalizedScore];
      })
    );
  }

  private applyDomainGoalBoost(results: SearchResult[], domain?: SearchOptions['domain']): SearchResult[] {
    if (!this.options.domainGoalStore || results.length === 0) {
      return results;
    }

    const domains = toArray(domain).filter((value): value is string => typeof value === 'string');
    if (domains.length !== 1) {
      return results;
    }

    const goal = this.options.domainGoalStore.get(domains[0]);
    if (!goal) {
      return results;
    }

    const boosts = boostByDomainGoal(
      results.map((result) => ({ entry: result.entry, score: result.relevance })),
      goal,
    );
    const boostMap = new Map(boosts.map((boost) => [boost.entryId, boost]));

    return results
      .map((result) => {
        const boost = boostMap.get(result.entry.id);
        if (!boost) {
          return result;
        }

        return {
          ...result,
          relevance: boost.boostedScore,
          domainGoalMatchedQuestions: boost.matchedQuestions,
        };
      })
      .sort((a, b) => b.relevance - a.relevance || b.entry.updatedAt.getTime() - a.entry.updatedAt.getTime());
  }
}

export class MockEmbeddingAdapter implements EmbeddingAdapter {
  constructor(private readonly dimensions = 64) {}

  async embed(text: string): Promise<number[]> {
    const vector = new Float64Array(this.dimensions);
    const tokens = tokenizeForEmbedding(text);

    if (tokens.length === 0) {
      return Array.from(vector);
    }

    for (const token of tokens) {
      const index = hash(token, this.dimensions);
      const sign = hash(`${token}:sign`, 2) === 0 ? 1 : -1;
      vector[index] += sign;
    }

    let norm = 0;
    for (const value of vector) {
      norm += value * value;
    }

    if (norm > 0) {
      const scale = Math.sqrt(norm);
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= scale;
      }
    }

    return Array.from(vector);
  }
}

function normalizeQuery(query: SearchQuery | string): SearchQuery {
  if (typeof query === 'string') {
    return { text: query, mode: 'hybrid' };
  }

  return {
    text: query.text.trim(),
    mode: query.mode ?? 'hybrid',
  };
}

function buildSemanticText(entry: KnowledgeEntry): string {
  return [entry.title, entry.summary, entry.content, entry.tags.join(' ')].join(' ');
}

function computeRelevance(mode: SearchMode, keywordScore: number, semanticScore: number): number {
  if (mode === 'keyword') {
    return keywordScore;
  }
  if (mode === 'semantic') {
    return semanticScore;
  }
  return Math.min(1, keywordScore * 0.45 + semanticScore * 0.55);
}

function normalizeArray<T>(value?: T | T[]): T | T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

function normalizeOffset(offset?: number): number {
  if (offset === undefined || offset < 0) {
    return 0;
  }
  return Math.floor(offset);
}

function normalizeLimit(limit: number | undefined, total: number): number {
  if (limit === undefined || limit <= 0) {
    return total;
  }
  return Math.floor(limit);
}

function tokenizeForEmbedding(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter(Boolean);
}

function hash(text: string, size: number): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) % size;
}

function toArray<T>(value?: T | T[]): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
