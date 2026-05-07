import { describe, expect, it } from 'vitest';
import { ChunkStrategy, estimateTokens } from '../chunk-strategy.js';
import type { ParsedSection } from '../document-parser.js';

function makeSection(content: string, title = '', level = 1): ParsedSection {
  return { title, content, level, metadata: {} };
}

describe('ChunkStrategy', () => {
  describe('chunkByHeading', () => {
    it('creates one chunk per section', () => {
      const strategy = new ChunkStrategy();
      const sections = [
        makeSection('Body A', 'Heading A', 1),
        makeSection('Body B', 'Heading B', 2),
      ];
      const chunks = strategy.chunkByHeading(sections);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].content).toContain('Heading A');
      expect(chunks[0].content).toContain('Body A');
      expect(chunks[1].index).toBe(1);
    });

    it('handles sections without title', () => {
      const strategy = new ChunkStrategy();
      const chunks = strategy.chunkByHeading([makeSection('Just text', '', 0)]);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('Just text');
    });
  });

  describe('chunkByTokenBudget', () => {
    it('keeps small text in one chunk', () => {
      const strategy = new ChunkStrategy({ maxTokens: 512 });
      const chunks = strategy.chunkByTokenBudget('Short text.');
      expect(chunks).toHaveLength(1);
    });

    it('splits large text into multiple chunks', () => {
      const strategy = new ChunkStrategy({ maxTokens: 10 });
      // chunkByTokenBudget splits on paragraph boundaries (double newlines)
      // ~10 tokens = ~40 chars; create paragraphs that exceed budget
      const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} with enough words to fill tokens.`);
      const text = paragraphs.join('\n\n');
      const chunks = strategy.chunkByTokenBudget(text);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('returns empty for empty text', () => {
      const strategy = new ChunkStrategy();
      expect(strategy.chunkByTokenBudget('')).toEqual([]);
    });
  });

  describe('chunkSectionsByTokenBudget', () => {
    it('keeps small sections intact', () => {
      const strategy = new ChunkStrategy({ maxTokens: 512 });
      const sections = [makeSection('Short', 'Title', 1)];
      const chunks = strategy.chunkSectionsByTokenBudget(sections);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].metadata.title).toBe('Title');
    });

    it('splits large sections', () => {
      const strategy = new ChunkStrategy({ maxTokens: 10 });
      const bigContent = 'Sentence one. Sentence two. Sentence three. Sentence four. Sentence five. Sentence six. Sentence seven. Sentence eight.';
      const sections = [makeSection(bigContent, 'Big', 1)];
      const chunks = strategy.chunkSectionsByTokenBudget(sections);
      expect(chunks.length).toBeGreaterThan(1);
    });
  });
});

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});
