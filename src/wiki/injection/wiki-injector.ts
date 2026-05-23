/**
 * FR-4 AC-4.1, AC-4.2, AC-4.5, AC-4.6, AC-4.7 | NFR-4
 * Wiki injector: retrieves relevant domain knowledge at agent bootstrap
 * and builds injection context for LLM consumption.
 */

import type { WikiEntryRecord, EmbeddingAdapter } from '../types.js';
import type { WikiRepository } from '../db/wiki-repository.js';
import { RelevanceScorer, type ScoredEntry } from './relevance-scorer.js';
import { ContextBuilder, type InjectionContext } from './context-builder.js';

export interface InjectionResult {
  context: InjectionContext;
  rendered: string;
  sources: Array<{ id: string; title: string; score: number }>;
  noHits: boolean;
}

export interface WikiInjectorOptions {
  /** Cosine similarity threshold for relevance filtering */
  relevanceThreshold?: number;
  /** Max token budget for injected context */
  tokenBudget?: number;
  /** Max candidate entries to retrieve from vector search */
  maxCandidates?: number;
}

const DEFAULT_OPTIONS: Required<WikiInjectorOptions> = {
  relevanceThreshold: 0.6,
  tokenBudget: 4000,
  maxCandidates: 20,
};

export class WikiInjector {
  private repository: WikiRepository;
  private embedder: EmbeddingAdapter;
  private scorer: RelevanceScorer;
  private contextBuilder: ContextBuilder;
  private maxCandidates: number;

  constructor(
    repository: WikiRepository,
    embedder: EmbeddingAdapter,
    options: WikiInjectorOptions = {},
  ) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.repository = repository;
    this.embedder = embedder;
    this.scorer = new RelevanceScorer(opts.relevanceThreshold);
    this.contextBuilder = new ContextBuilder(opts.tokenBudget);
    this.maxCandidates = opts.maxCandidates;
  }

  /**
   * Injects relevant wiki knowledge for a given user message/query.
   * Called during agent bootstrap to enrich context.
   * Degrades gracefully if embedding/vector service is unavailable.
   */
  async inject(query: string): Promise<InjectionResult> {
    let queryEmbedding: number[];
    try {
      // Step 1: Embed the query
      queryEmbedding = await this.embedder.embed(query);
    } catch {
      // Degradation: embedding service unavailable, skip injection
      return this.emptyResult();
    }

    // Step 2: Retrieve candidate entries via vector search
    const candidates = this.repository.findByVector(queryEmbedding, this.maxCandidates);

    // Step 3: Score and filter by relevance
    const scored = this.scorer.score(candidates, queryEmbedding);

    // Step 4: Build context within token budget
    const context = this.contextBuilder.build(scored);

    // Step 5: Render for injection
    const rendered = this.contextBuilder.render(context);

    // Step 6: Extract sources for traceability (AC-4.6)
    const sources = context.fragments.map((f) => ({
      id: f.id,
      title: f.title,
      score: f.score,
    }));

    // AC-4.7: Track no-hit scenarios
    const noHits = scored.length === 0;

    return { context, rendered, sources, noHits };
  }

  /**
   * Injects with scope filtering (specific space or directory).
   * Degrades gracefully if embedding/vector service is unavailable.
   */
  async injectWithScope(
    query: string,
    scope?: { spaceId?: string; directoryId?: string },
  ): Promise<InjectionResult> {
    if (!scope?.spaceId && !scope?.directoryId) {
      return this.inject(query);
    }

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embedder.embed(query);
    } catch {
      // Degradation: embedding unavailable, skip injection
      return this.emptyResult();
    }

    // Use scoped search from repository
    const candidates = this.repository.search(query, scope);

    // Re-score with embeddings for semantic ranking
    const scored = this.scorer.score(candidates, queryEmbedding);
    const context = this.contextBuilder.build(scored);
    const rendered = this.contextBuilder.render(context);

    const sources = context.fragments.map((f) => ({
      id: f.id,
      title: f.title,
      score: f.score,
    }));

    return { context, rendered, sources, noHits: scored.length === 0 };
  }

  /** Returns an empty injection result for degradation scenarios. */
  private emptyResult(): InjectionResult {
    const context = this.contextBuilder.build([]);
    return {
      context,
      rendered: '',
      sources: [],
      noHits: true,
    };
  }
}
