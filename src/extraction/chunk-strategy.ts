/**
 * ChunkStrategy — Document chunking strategies.
 *
 * Provides multiple strategies for splitting content into chunks:
 * 1. By heading (default) — each heading section is a chunk
 * 2. By token budget — split into chunks of maxTokens size
 * 3. With overlap window — chunks overlap by overlapTokens
 *
 * Token estimation: ~4 chars per token (rough approximation for mixed CJK/Latin).
 */

import type { ParsedSection } from './document-parser.js';

export interface ChunkOptions {
  /** Maximum tokens per chunk (default: 512) */
  maxTokens?: number;
  /** Overlap tokens between consecutive chunks (default: 0) */
  overlapTokens?: number;
}

export interface Chunk {
  content: string;
  index: number;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
}

/** Approximate token count: ~4 chars per token for mixed content */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ChunkStrategy {
  private maxTokens: number;
  private overlapTokens: number;

  constructor(options: ChunkOptions = {}) {
    this.maxTokens = options.maxTokens ?? 512;
    this.overlapTokens = options.overlapTokens ?? 0;
  }

  /**
   * Chunk by heading — each ParsedSection becomes one chunk.
   * This is the default strategy.
   */
  chunkByHeading(sections: ParsedSection[]): Chunk[] {
    return sections.map((section, index) => {
      const content = section.title
        ? `${'#'.repeat(section.level || 1)} ${section.title}\n${section.content}`
        : section.content;

      return {
        content,
        index,
        tokenEstimate: estimateTokens(content),
        metadata: { ...section.metadata, title: section.title, level: section.level },
      };
    });
  }

  /**
   * Chunk by token budget — split text into chunks respecting maxTokens.
   * Splits at paragraph boundaries when possible.
   */
  chunkByTokenBudget(text: string): Chunk[] {
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    const chunks: Chunk[] = [];
    let currentContent = '';
    let currentTokens = 0;
    let chunkIndex = 0;

    for (const paragraph of paragraphs) {
      const paraTokens = estimateTokens(paragraph);

      // If single paragraph exceeds budget, split it by sentences
      if (paraTokens > this.maxTokens) {
        // Flush current buffer first
        if (currentContent.trim()) {
          chunks.push(this.createChunk(currentContent.trim(), chunkIndex++));
          currentContent = '';
          currentTokens = 0;
        }
        // Split large paragraph
        const subChunks = this.splitLargeParagraph(paragraph, chunkIndex);
        chunks.push(...subChunks);
        chunkIndex += subChunks.length;
        continue;
      }

      // Would adding this paragraph exceed budget?
      if (currentTokens + paraTokens > this.maxTokens && currentContent.trim()) {
        chunks.push(this.createChunk(currentContent.trim(), chunkIndex++));
        // Apply overlap: carry over tail of previous chunk
        currentContent = this.getOverlapText(currentContent);
        currentTokens = estimateTokens(currentContent);
      }

      currentContent += (currentContent ? '\n\n' : '') + paragraph;
      currentTokens += paraTokens;
    }

    // Flush remaining
    if (currentContent.trim()) {
      chunks.push(this.createChunk(currentContent.trim(), chunkIndex));
    }

    return chunks;
  }

  /**
   * Chunk sections by token budget — applies token budget to each section,
   * splitting large sections into multiple chunks.
   */
  chunkSectionsByTokenBudget(sections: ParsedSection[]): Chunk[] {
    const chunks: Chunk[] = [];
    let globalIndex = 0;

    for (const section of sections) {
      const fullContent = section.title
        ? `${'#'.repeat(section.level || 1)} ${section.title}\n${section.content}`
        : section.content;

      const tokens = estimateTokens(fullContent);

      if (tokens <= this.maxTokens) {
        chunks.push({
          content: fullContent,
          index: globalIndex++,
          tokenEstimate: tokens,
          metadata: { ...section.metadata, title: section.title, level: section.level },
        });
      } else {
        // Split this section by token budget
        const subChunks = this.chunkByTokenBudget(fullContent);
        for (const sub of subChunks) {
          chunks.push({
            ...sub,
            index: globalIndex++,
            metadata: { ...section.metadata, title: section.title, level: section.level },
          });
        }
      }
    }

    return chunks;
  }

  private createChunk(content: string, index: number): Chunk {
    return {
      content,
      index,
      tokenEstimate: estimateTokens(content),
      metadata: {},
    };
  }

  private splitLargeParagraph(paragraph: string, startIndex: number): Chunk[] {
    const sentences = paragraph.match(/[^.!?。！？]+[.!?。！？]?/g) || [paragraph];
    const chunks: Chunk[] = [];
    let current = '';
    let currentTokens = 0;
    let idx = startIndex;

    for (const sentence of sentences) {
      const sentTokens = estimateTokens(sentence);

      if (currentTokens + sentTokens > this.maxTokens && current.trim()) {
        chunks.push(this.createChunk(current.trim(), idx++));
        current = this.getOverlapText(current);
        currentTokens = estimateTokens(current);
      }

      current += sentence;
      currentTokens += sentTokens;
    }

    if (current.trim()) {
      chunks.push(this.createChunk(current.trim(), idx));
    }

    return chunks;
  }

  /**
   * Get overlap text from the tail of content.
   * Returns approximately overlapTokens worth of trailing text.
   */
  private getOverlapText(content: string): string {
    if (this.overlapTokens <= 0) return '';

    const overlapChars = this.overlapTokens * 4;
    if (content.length <= overlapChars) return content;

    return content.slice(-overlapChars);
  }
}

export { estimateTokens };
