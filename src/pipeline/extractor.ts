/**
 * Extractor — Extracts structured knowledge entries from raw text.
 *
 * Paragraph-based splitting + classifier assignment.
 * Future: LLM-backed extraction with semantic chunking.
 *
 * Follows ADR-001 (pipeline filter) and ADR-005 (definition/execution separation):
 * Extractor defines extraction logic; actual LLM calls delegated to host in future.
 */

import { randomUUID } from 'node:crypto';
import type { KnowledgeEntry, KnowledgeSource } from '../types/index.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import { Classifier } from './classifier.js';

export interface ExtractorOptions {
  /** Minimum content length to consider a paragraph extractable */
  minContentLength?: number;
  /** Custom classifier instance */
  classifier?: Classifier;
  /** Minimum confidence threshold (retained for scoring; all entries are 'active') */
  minConfidence?: number;
}

export class Extractor {
  private classifier: Classifier;
  private minContentLength: number;
  private minConfidence: number;

  constructor(options: ExtractorOptions = {}) {
    this.classifier = options.classifier ?? new Classifier();
    this.minContentLength = options.minContentLength ?? 20;
    this.minConfidence = options.minConfidence ?? 0.7;
  }

  /**
   * Extract knowledge entries from raw text.
   * Splits by paragraphs, classifies each, returns structured entries.
   */
  async extract(text: string, source: KnowledgeSource): Promise<KnowledgeEntry[]> {
    const paragraphs = this.splitIntoParagraphs(text);
    const entries: KnowledgeEntry[] = [];

    for (const paragraph of paragraphs) {
      if (paragraph.length < this.minContentLength) continue;

      const { type, confidence } = await this.classifier.classify(paragraph);
      const now = new Date();

      entries.push({
        id: randomUUID(),
        type,
        title: this.generateTitle(paragraph),
        content: paragraph,
        summary: this.generateSummary(paragraph),
        source,
        confidence,
        status: 'active',
        tags: [],
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
    }

    return entries;
  }

  private splitIntoParagraphs(text: string): string[] {
    return text
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(p => p.length > 0);
  }

  private generateTitle(content: string): string {
    return shortenKnowledgeTitle(content);
  }

  private generateSummary(content: string): string {
    // First sentence or first 100 chars
    const firstSentence = content.match(/^[^.!?。！？]+[.!?。！？]/);
    if (firstSentence && firstSentence[0].length <= 150) {
      return firstSentence[0];
    }
    return content.slice(0, 100) + (content.length > 100 ? '...' : '');
  }
}
