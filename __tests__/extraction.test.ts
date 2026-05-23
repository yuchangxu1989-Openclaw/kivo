/**
 * Tests for FR-A02: Document Knowledge Extraction module.
 *
 * Covers:
 * - MarkdownParser heading-level parsing
 * - MarkdownParser frontmatter extraction
 * - DocumentExtractor type classification
 * - ChunkStrategy token budget splitting
 * - Pipeline compatibility (KnowledgeEntry shape)
 */

import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../src/extraction/document-parser.js';
import { DocumentExtractor } from '../src/extraction/document-extractor.js';
import { ChunkStrategy, estimateTokens } from '../src/extraction/chunk-strategy.js';
import type { KnowledgeSource, KnowledgeEntry } from '../src/types/index.js';

const testSource: KnowledgeSource = {
  type: 'document',
  reference: 'test://doc.md',
  timestamp: new Date('2025-01-01'),
};

// ─── MarkdownParser ──────────────────────────────────────────────────────────

describe('MarkdownParser', () => {
  const parser = new MarkdownParser();

  it('parses heading levels correctly', () => {
    const md = `# Title\n\nIntro paragraph.\n\n## Section A\n\nContent A.\n\n### Subsection A1\n\nDeep content.\n\n## Section B\n\nContent B.`;
    const sections = parser.parse(md, testSource);

    expect(sections.length).toBe(4);
    expect(sections[0]).toMatchObject({ title: 'Title', level: 1 });
    expect(sections[1]).toMatchObject({ title: 'Section A', level: 2 });
    expect(sections[2]).toMatchObject({ title: 'Subsection A1', level: 3 });
    expect(sections[3]).toMatchObject({ title: 'Section B', level: 2 });
  });

  it('handles content before first heading as level-0 section', () => {
    const md = `Some preamble text.\n\n# First Heading\n\nBody.`;
    const sections = parser.parse(md, testSource);

    expect(sections[0]).toMatchObject({ title: '', level: 0, content: 'Some preamble text.' });
    expect(sections[1]).toMatchObject({ title: 'First Heading', level: 1 });
  });

  it('handles document with no headings', () => {
    const md = `Just plain text without any headings.\n\nAnother paragraph.`;
    const sections = parser.parse(md, testSource);

    expect(sections.length).toBe(1);
    expect(sections[0].level).toBe(0);
    expect(sections[0].content).toContain('Just plain text');
  });

  it('extracts frontmatter metadata', () => {
    const md = `---\ntitle: My Document\ntags:\n- ai\n- knowledge\ndomain: engineering\n---\n\n# Heading\n\nContent here.`;
    const sections = parser.parse(md, testSource);

    expect(sections.length).toBe(1);
    expect(sections[0].metadata.title).toBe('My Document');
    expect(sections[0].metadata.tags).toEqual(['ai', 'knowledge']);
    expect(sections[0].metadata.domain).toBe('engineering');
  });

  it('handles frontmatter with comma-separated tags', () => {
    const md = `---\ntitle: Test\ntags: ai, ml, nlp\n---\n\n# H1\n\nBody.`;
    const sections = parser.parse(md, testSource);

    expect(sections[0].metadata.tags).toEqual(['ai', 'ml', 'nlp']);
  });

  it('handles empty document', () => {
    const sections = parser.parse('', testSource);
    expect(sections.length).toBe(0);
  });

  it('preserves section content between headings', () => {
    const md = `# A\n\nLine 1.\nLine 2.\n\n## B\n\nLine 3.`;
    const sections = parser.parse(md, testSource);

    expect(sections[0].content).toBe('Line 1.\nLine 2.');
    expect(sections[1].content).toBe('Line 3.');
  });
});

// ─── DocumentExtractor ───────────────────────────────────────────────────────

describe('DocumentExtractor', () => {
  const extractor = new DocumentExtractor();
  const parser = new MarkdownParser();

  it('generates KnowledgeEntry for each section', async () => {
    const md = `# Facts\n\nThe system has 100 users. Data shows 50% growth.\n\n# Methods\n\n步骤 1: 分析需求\n步骤 2: 设计方案\n步骤 3: 实现代码`;
    const sections = parser.parse(md, testSource);
    const entries = await extractor.extract(sections, testSource);

    expect(entries.length).toBe(2);
    expect(entries.every(e => e.id)).toBe(true);
    expect(entries.every(e => e.source === testSource)).toBe(true);
  });

  it('classifies fact-like content as fact', async () => {
    const md = `# Data\n\n用户数量是 1000，增长比例为 25%。`;
    const sections = parser.parse(md, testSource);
    const entries = await extractor.extract(sections, testSource);

    expect(entries[0].type).toBe('fact');
  });

  it('classifies methodology-like content as methodology', async () => {
    const md = `# Process\n\n方法论框架：\n1. 分析\n2. 设计\n3. 实现\n4. 验证`;
    const sections = parser.parse(md, testSource);
    const entries = await extractor.extract(sections, testSource);

    expect(entries[0].type).toBe('methodology');
  });

  it('propagates frontmatter tags and domain to entries', async () => {
    const md = `---\ntags:\n- architecture\n- design\ndomain: software\n---\n\n# Architecture\n\nSystem design principles and patterns.`;
    const sections = parser.parse(md, testSource);
    const entries = await extractor.extract(sections, testSource);

    expect(entries[0].tags).toEqual(['architecture', 'design']);
    expect(entries[0].domain).toBe('software');
  });

  it('skips sections with insufficient content', async () => {
    const md = `# A\n\nOK content here is enough.\n\n# B\n\nToo short`;
    const extractor2 = new DocumentExtractor({ minContentLength: 20 });
    const sections = parser.parse(md, testSource);
    const entries = await extractor2.extract(sections, testSource);

    // "B\nToo short" = 11 chars, below threshold
    expect(entries.length).toBe(1);
    expect(entries[0].title).toBe('A');
  });

  it('produces entries compatible with Repository (KnowledgeEntry shape)', async () => {
    const md = `# Test Entry\n\nThis is a test entry with enough content to be extracted.`;
    const sections = parser.parse(md, testSource);
    const entries = await extractor.extract(sections, testSource);

    const entry: KnowledgeEntry = entries[0];
    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('type');
    expect(entry).toHaveProperty('title');
    expect(entry).toHaveProperty('content');
    expect(entry).toHaveProperty('summary');
    expect(entry).toHaveProperty('source');
    expect(entry).toHaveProperty('confidence');
    expect(entry).toHaveProperty('status');
    expect(entry).toHaveProperty('tags');
    expect(entry).toHaveProperty('createdAt');
    expect(entry).toHaveProperty('updatedAt');
    expect(entry).toHaveProperty('version');
    expect(entry.version).toBe(1);
    expect(['active', 'pending']).toContain(entry.status);
  });

  it('uses section title as entry title', async () => {
    const md = `# My Custom Title\n\nSome body content for this section.`;
    const sections = parser.parse(md, testSource);
    const entries = await extractor.extract(sections, testSource);

    expect(entries[0].title).toBe('My Custom Title');
  });
});

// ─── ChunkStrategy ───────────────────────────────────────────────────────────

describe('ChunkStrategy', () => {
  it('chunks by heading — one chunk per section', () => {
    const parser = new MarkdownParser();
    const strategy = new ChunkStrategy();
    const md = `# A\n\nContent A.\n\n# B\n\nContent B.\n\n# C\n\nContent C.`;
    const sections = parser.parse(md, testSource);
    const chunks = strategy.chunkByHeading(sections);

    expect(chunks.length).toBe(3);
    expect(chunks[0].content).toContain('# A');
    expect(chunks[1].content).toContain('# B');
    expect(chunks[2].content).toContain('# C');
  });

  it('chunks by token budget — respects maxTokens', () => {
    // Each paragraph ~25 tokens (100 chars / 4)
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      `Paragraph ${i}: ${'x'.repeat(90)}`
    ).join('\n\n');

    const strategy = new ChunkStrategy({ maxTokens: 60 });
    const chunks = strategy.chunkByTokenBudget(paragraphs);

    // Each paragraph is ~25 tokens, budget is 60, so ~2 paragraphs per chunk
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(60);
    }
  });

  it('handles overlap window between chunks', () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) =>
      `Section ${i} content here.`
    ).join('\n\n');

    const strategy = new ChunkStrategy({ maxTokens: 20, overlapTokens: 5 });
    const chunks = strategy.chunkByTokenBudget(paragraphs);

    // With overlap, later chunks should contain some text from previous chunk's tail
    expect(chunks.length).toBeGreaterThan(1);
    if (chunks.length >= 2) {
      // Overlap means chunk[1] starts with tail of chunk[0]'s content
      const overlapChars = 5 * 4; // 20 chars
      const chunk0Tail = chunks[0].content.slice(-overlapChars);
      expect(chunks[1].content.startsWith(chunk0Tail)).toBe(true);
    }
  });

  it('estimateTokens approximates correctly', () => {
    expect(estimateTokens('hello')).toBe(2); // 5/4 = 1.25 → ceil = 2
    expect(estimateTokens('a'.repeat(100))).toBe(25); // 100/4 = 25
    expect(estimateTokens('')).toBe(0);
  });

  it('chunkSectionsByTokenBudget splits large sections', () => {
    const parser = new MarkdownParser();
    const strategy = new ChunkStrategy({ maxTokens: 30 });

    // Create a section with content that exceeds 30 tokens (120+ chars)
    const md = `# Big Section\n\n${'This is a sentence. '.repeat(10)}`;
    const sections = parser.parse(md, testSource);
    const chunks = strategy.chunkSectionsByTokenBudget(sections);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(30);
    }
  });

  it('preserves metadata in heading chunks', () => {
    const parser = new MarkdownParser();
    const strategy = new ChunkStrategy();
    const md = `---\ndomain: test\n---\n\n# Section\n\nContent.`;
    const sections = parser.parse(md, testSource);
    const chunks = strategy.chunkByHeading(sections);

    expect(chunks[0].metadata.domain).toBe('test');
    expect(chunks[0].metadata.title).toBe('Section');
  });
});

// ─── Integration: Full pipeline ──────────────────────────────────────────────

describe('Document Extraction Integration', () => {
  it('full flow: parse → extract → entries ready for Repository', async () => {
    const parser = new MarkdownParser();
    const extractor = new DocumentExtractor();

    const md = `---
title: Architecture Guide
tags:
- architecture
- patterns
domain: software-engineering
---

# Overview

This document defines the system architecture. The system has 3 main components.

# Design Patterns

方法论框架：
1. 识别问题域
2. 匹配合适的模式
3. 应用并验证

# Decisions

决定采用事件驱动架构，放弃传统 MVC，权衡了可维护性和复杂度。`;

    const sections = parser.parse(md, testSource);
    expect(sections.length).toBe(3);

    const entries = await extractor.extract(sections, testSource);
    expect(entries.length).toBe(3);

    // All entries have required fields
    for (const entry of entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.type).toBeTruthy();
      expect(entry.title).toBeTruthy();
      expect(entry.content).toBeTruthy();
      expect(entry.source).toBe(testSource);
      expect(entry.tags).toEqual(['architecture', 'patterns']);
      expect(entry.domain).toBe('software-engineering');
      expect(entry.version).toBe(1);
    }

    // Type classification
    expect(entries[0].type).toBe('fact'); // "has 3 main components" → fact
    expect(entries[1].type).toBe('methodology'); // numbered steps
    expect(entries[2].type).toBe('decision'); // "决定采用...放弃...权衡"
  });
});
