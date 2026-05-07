import { describe, expect, it } from 'vitest';
import { MarkdownParser, PlainTextParser } from '../document-parser.js';
import type { KnowledgeSource } from '../../types/index.js';

const testSource: KnowledgeSource = {
  type: 'document',
  reference: 'test://doc',
  timestamp: new Date(),
};

describe('MarkdownParser', () => {
  const parser = new MarkdownParser();

  it('extracts YAML frontmatter', () => {
    const content = `---
title: My Doc
tags: a, b, c
domain: test
---

# Heading 1

Body text here.`;

    const sections = parser.parse(content, testSource);
    expect(sections.length).toBeGreaterThanOrEqual(1);
    // Frontmatter should be attached as metadata
    const withMeta = sections.find(s => s.metadata.title === 'My Doc');
    expect(withMeta).toBeDefined();
    expect(withMeta!.metadata.domain).toBe('test');
    expect(withMeta!.metadata.tags).toEqual(['a', 'b', 'c']);
  });

  it('splits by headings', () => {
    const content = `# Section A

Content A

## Section B

Content B

# Section C

Content C`;

    const sections = parser.parse(content, testSource);
    expect(sections.length).toBe(3);
    expect(sections[0].title).toBe('Section A');
    expect(sections[1].title).toBe('Section B');
    expect(sections[2].title).toBe('Section C');
  });

  it('handles content before first heading', () => {
    const content = `Preamble text

# First Heading

Body`;

    const sections = parser.parse(content, testSource);
    expect(sections.length).toBe(2);
    expect(sections[0].title).toBe('');
    expect(sections[0].content).toBe('Preamble text');
  });

  it('handles document with no headings', () => {
    const content = 'Just plain text with no headings.';
    const sections = parser.parse(content, testSource);
    expect(sections).toHaveLength(1);
    expect(sections[0].level).toBe(0);
  });

  it('returns empty for empty content', () => {
    const sections = parser.parse('', testSource);
    expect(sections).toEqual([]);
  });

  it('extractFrontmatter returns empty when no frontmatter', () => {
    const { frontmatter, body } = parser.extractFrontmatter('# No frontmatter');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# No frontmatter');
  });
});

describe('PlainTextParser', () => {
  const parser = new PlainTextParser();

  it('splits by double newlines', () => {
    const content = `Paragraph one.

Paragraph two.

Paragraph three.`;

    const sections = parser.parse(content, testSource);
    expect(sections).toHaveLength(3);
    expect(sections[0].content).toBe('Paragraph one.');
    expect(sections[1].content).toBe('Paragraph two.');
  });

  it('returns empty for empty content', () => {
    expect(parser.parse('', testSource)).toEqual([]);
  });

  it('all sections have level 0', () => {
    const sections = parser.parse('A\n\nB', testSource);
    for (const s of sections) {
      expect(s.level).toBe(0);
    }
  });
});
