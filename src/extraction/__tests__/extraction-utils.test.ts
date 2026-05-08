import { describe, expect, it } from 'vitest';
import {
  isKnowledgeType,
  clampConfidence,
  generateTitle,
  generateSummary,
  uniqueTags,
  normalizeForDedupe,
  dedupeKey,
  extractJsonBlock,
  normalizeKnowledgeCandidates,
  isDuplicateEntry,
  shortenKnowledgeTitle,
} from '../extraction-utils.js';
import type { KnowledgeEntry } from '../../types/index.js';

describe('extraction-utils', () => {
  describe('isKnowledgeType', () => {
    it('accepts valid types', () => {
      expect(isKnowledgeType('fact')).toBe(true);
      expect(isKnowledgeType('methodology')).toBe(true);
      expect(isKnowledgeType('intent')).toBe(true);
    });

    it('rejects invalid types', () => {
      expect(isKnowledgeType('unknown')).toBe(false);
      expect(isKnowledgeType(undefined)).toBe(false);
    });
  });

  describe('clampConfidence', () => {
    it('clamps to [0, 1]', () => {
      expect(clampConfidence(1.5)).toBe(1);
      expect(clampConfidence(-0.5)).toBe(0);
      expect(clampConfidence(0.7)).toBe(0.7);
    });

    it('returns fallback for NaN/undefined', () => {
      expect(clampConfidence(NaN)).toBe(0.6);
      expect(clampConfidence(undefined)).toBe(0.6);
      expect(clampConfidence(undefined, 0.5)).toBe(0.5);
    });
  });

  describe('generateTitle', () => {
    it('truncates long content to <= 43 chars using ellipsis fallback', () => {
      const long = 'A'.repeat(100);
      const title = generateTitle(long);
      expect(title.length).toBeLessThanOrEqual(43);
      expect(title).toContain('...');
    });

    it('returns fallback for empty content', () => {
      expect(generateTitle('')).toBe('Untitled knowledge entry');
    });
  });

  describe('shortenKnowledgeTitle', () => {
    it('cuts long titles at punctuation when possible', () => {
      // Input must be > 50 chars to trigger truncation; punctuation at position 4
      expect(shortenKnowledgeTitle('这是标题，后面是展开说明的内容比较长而且超过了五十个字符的限制所以需要被截断处理掉多余部分')).toBe('这是标题');
    });

    it('falls back to first 40 chars plus ellipsis when no punctuation exists', () => {
      // Input must be > 50 chars with no punctuation to trigger fallback
      const title = shortenKnowledgeTitle('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890');
      expect(title).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn...');
      expect(title.length).toBeLessThanOrEqual(43);
    });

    it('uses fallback content when title is empty', () => {
      expect(shortenKnowledgeTitle('', '短内容标题')).toBe('短内容标题');
    });
  });

  describe('generateSummary', () => {
    it('extracts first sentence', () => {
      expect(generateSummary('Hello world. More text.')).toBe('Hello world.');
    });

    it('returns empty for empty content', () => {
      expect(generateSummary('')).toBe('');
    });
  });

  describe('uniqueTags', () => {
    it('deduplicates and trims', () => {
      expect(uniqueTags(['a', ' a ', 'b', 'b'])).toEqual(['a', 'b']);
    });

    it('returns empty for non-array', () => {
      expect(uniqueTags(undefined)).toEqual([]);
    });
  });

  describe('normalizeForDedupe', () => {
    it('lowercases and strips punctuation', () => {
      expect(normalizeForDedupe('Hello, World!')).toBe('hello world');
    });
  });

  describe('dedupeKey', () => {
    it('combines type and normalized content', () => {
      expect(dedupeKey('fact', 'Hello!')).toBe('fact:hello');
    });
  });

  describe('extractJsonBlock', () => {
    it('parses raw JSON array', () => {
      expect(extractJsonBlock('[1, 2]')).toEqual([1, 2]);
    });

    it('extracts from fenced code block', () => {
      const raw = 'Some text\n```json\n{"a": 1}\n```\nMore text';
      expect(extractJsonBlock(raw)).toEqual({ a: 1 });
    });

    it('throws for non-JSON', () => {
      expect(() => extractJsonBlock('not json at all')).toThrow();
    });

    it('returns empty array for empty string', () => {
      expect(extractJsonBlock('[]')).toEqual([]);
    });
  });

  describe('normalizeKnowledgeCandidates', () => {
    it('returns array items that are objects', () => {
      const result = normalizeKnowledgeCandidates([{ type: 'fact' }, 'skip']);
      expect(result).toHaveLength(1);
    });

    it('extracts .entries from object', () => {
      const result = normalizeKnowledgeCandidates({ entries: [{ type: 'fact' }] });
      expect(result).toHaveLength(1);
    });
  });

  describe('isDuplicateEntry', () => {
    it('detects duplicate by type + normalized content', () => {
      const existing: KnowledgeEntry[] = [{
        id: 'e1', type: 'fact', title: 't', content: 'Hello!',
        summary: 's', source: { type: 'manual', reference: 'r', timestamp: new Date() },
        confidence: 0.9, status: 'active', tags: [], domain: 'd',
        createdAt: new Date(), updatedAt: new Date(), version: 1,
      }];
      expect(isDuplicateEntry({ type: 'fact', content: 'hello' }, existing)).toBe(true);
      expect(isDuplicateEntry({ type: 'methodology', content: 'hello' }, existing)).toBe(false);
    });
  });
});
