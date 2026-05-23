/**
 * IntentMatchStatsProvider — FR-W10 AC5 意图匹配统计
 *
 * 记录意图匹配命中事件，提供 30 天统计和典型命中对话片段。
 */

import type { IntentMatchStats } from './workbench-types.js';
import type { IntentMatchStatsProvider } from './intent-management-service.js';

export interface IntentMatchEvent {
  intentId: string;
  timestamp: Date;
  snippet: string;
  confidence: number;
}

const DEFAULT_MAX_SNIPPETS = 5;

export class InMemoryIntentMatchStatsProvider implements IntentMatchStatsProvider {
  private events: IntentMatchEvent[] = [];
  private maxSnippets: number;

  constructor(opts?: { maxSnippets?: number }) {
    this.maxSnippets = opts?.maxSnippets ?? DEFAULT_MAX_SNIPPETS;
  }

  /** Record a match hit for an intent */
  recordMatch(intentId: string, snippet: string, confidence: number = 1): void {
    this.events.push({
      intentId,
      timestamp: new Date(),
      snippet,
      confidence,
    });
  }

  /** AC5: Get stats for an intent over the last N days */
  async getStats(intentId: string, days: number): Promise<IntentMatchStats> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const relevant = this.events.filter(
      (e) => e.intentId === intentId && e.timestamp >= cutoff,
    );

    // Pick top snippets by confidence, deduplicated
    const seen = new Set<string>();
    const typicalSnippets: string[] = [];
    const sorted = [...relevant].sort((a, b) => b.confidence - a.confidence);
    for (const evt of sorted) {
      if (typicalSnippets.length >= this.maxSnippets) break;
      const normalized = evt.snippet.trim();
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        typicalSnippets.push(normalized);
      }
    }

    return {
      last30DaysHits: relevant.length,
      typicalSnippets,
    };
  }

  /** Get all recorded events (for debugging/testing) */
  getAllEvents(): readonly IntentMatchEvent[] {
    return this.events;
  }

  /** Prune events older than the given number of days */
  prune(days: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const before = this.events.length;
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
    return before - this.events.length;
  }

  clear(): void {
    this.events = [];
  }
}
