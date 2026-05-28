/**
 * FR-2 AC-2.4
 * Run lightweight Louvain-style community discovery using weighted graph edges.
 */

import { randomUUID } from 'node:crypto';
import { WikiRepository } from '../db/wiki-repository.js';
import type { GraphSignalWeights, WikiCommunitySuggestion, WikiEntryRecord } from '../types.js';

export interface WeightedGraphEdge {
  sourceId: string;
  targetId: string;
  weight: number;
  signals?: GraphSignalWeights;
}

export interface WikiGraphAdapter {
  getWeightedEdges(pageIds: string[]): Promise<WeightedGraphEdge[]>;
}

export class LouvainScheduler {
  constructor(
    private readonly repository: WikiRepository,
    private readonly graphAdapter: WikiGraphAdapter,
  ) {}

  async run(): Promise<WikiCommunitySuggestion[]> {
    const pages = this.repository.listAllPages();
    if (pages.length === 0) {
      this.repository.saveCommunitySuggestions([]);
      return [];
    }

    const pageIds = pages.map((page) => page.id);
    const adapterEdges = await this.graphAdapter.getWeightedEdges(pageIds);
    const edges = adapterEdges.length > 0 ? adapterEdges : computeFourSignalEdges(pages);
    const communities = computeCommunities(pageIds, edges);
    const suggestions = Array.from(communities.entries()).map(([communityKey, ids]) => ({
      id: randomUUID(),
      pageIds: ids,
      communityKey,
      score: scoreCommunity(ids, edges),
      createdAt: new Date().toISOString(),
    }));
    this.repository.saveCommunitySuggestions(suggestions);
    return suggestions;
  }
}

function computeCommunities(pageIds: string[], edges: WeightedGraphEdge[]): Map<string, string[]> {
  const neighbors = new Map<string, WeightedGraphEdge[]>();
  const community = new Map<string, string>();
  for (const id of pageIds) {
    community.set(id, id);
    neighbors.set(id, []);
  }
  for (const edge of edges) {
    neighbors.get(edge.sourceId)?.push(edge);
    neighbors.get(edge.targetId)?.push(edge);
  }

  let changed = true;
  let rounds = 0;
  while (changed && rounds < 10) {
    changed = false;
    rounds += 1;
    for (const nodeId of pageIds) {
      const scores = new Map<string, number>();
      for (const edge of neighbors.get(nodeId) ?? []) {
        const otherId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
        const key = community.get(otherId) ?? otherId;
        scores.set(key, (scores.get(key) ?? 0) + edge.weight);
      }
      const best = Array.from(scores.entries()).sort((a, b) => b[1] - a[1])[0];
      if (best && best[0] !== community.get(nodeId)) {
        community.set(nodeId, best[0]);
        changed = true;
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const nodeId of pageIds) {
    const key = community.get(nodeId) ?? nodeId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(nodeId);
  }
  return groups;
}

function scoreCommunity(ids: string[], edges: WeightedGraphEdge[]): number {
  const idSet = new Set(ids);
  return edges
    .filter((edge) => idSet.has(edge.sourceId) && idSet.has(edge.targetId))
    .reduce((sum, edge) => sum + edge.weight, 0);
}


function computeFourSignalEdges(pages: WikiEntryRecord[]): WeightedGraphEdge[] {
  const edges: WeightedGraphEdge[] = [];
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const a = pages[i];
      const b = pages[j];
      const signals: GraphSignalWeights = {
        coOccurrence: coOccurrenceScore(a, b),
        semanticSimilarity: semanticScore(a, b),
        citation: citationScore(a, b),
        timeDecay: timeDecayScore(a, b),
      };
      const weight = Math.min(1, Math.max(0,
        signals.coOccurrence * 0.25 +
        signals.semanticSimilarity * 0.35 +
        signals.citation * 0.25 +
        signals.timeDecay * 0.15,
      ));
      if (weight > 0) {
        edges.push({ sourceId: a.id, targetId: b.id, weight, signals });
      }
    }
  }
  return edges;
}

function coOccurrenceScore(a: WikiEntryRecord, b: WikiEntryRecord): number {
  const aTags = new Set(a.tags.map((tag) => tag.toLowerCase()));
  const bTags = new Set(b.tags.map((tag) => tag.toLowerCase()));
  const sharedTags = Array.from(aTags).filter((tag) => bTags.has(tag)).length;
  const aWords = terms(`${a.title} ${a.summary}`);
  const bWords = terms(`${b.title} ${b.summary}`);
  const sharedWords = Array.from(aWords).filter((term) => bWords.has(term)).length;
  return Math.min(1, (sharedTags * 0.4) + (sharedWords * 0.1));
}

function semanticScore(a: WikiEntryRecord, b: WikiEntryRecord): number {
  if (!a.embedding || !b.embedding || a.embedding.length !== b.embedding.length || a.embedding.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.embedding.length; i++) {
    dot += a.embedding[i] * b.embedding[i];
    normA += a.embedding[i] * a.embedding[i];
    normB += b.embedding[i] * b.embedding[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : Math.max(0, dot / denom);
}

function citationScore(a: WikiEntryRecord, b: WikiEntryRecord): number {
  const aLinks = (a.metadata.links ?? []).map((link) => link.targetPageId ?? link.targetTitle.toLowerCase());
  const bLinks = (b.metadata.links ?? []).map((link) => link.targetPageId ?? link.targetTitle.toLowerCase());
  if (aLinks.includes(b.id) || aLinks.includes(b.title.toLowerCase())) return 1;
  if (bLinks.includes(a.id) || bLinks.includes(a.title.toLowerCase())) return 1;
  return 0;
}

function timeDecayScore(a: WikiEntryRecord, b: WikiEntryRecord): number {
  const newest = Math.max(Date.parse(a.updatedAt), Date.parse(b.updatedAt));
  if (!Number.isFinite(newest)) return 0;
  const ageDays = Math.max(0, (Date.now() - newest) / 86_400_000);
  return Math.exp(-ageDays / 90);
}

function terms(content: string): Set<string> {
  return new Set(content.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1));
}
