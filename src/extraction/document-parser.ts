/**
 * DocumentParser — SPI interface + MarkdownParser implementation.
 *
 * Parses structured documents into sections for downstream extraction.
 * Supports frontmatter metadata extraction and heading-based sectioning.
 */

import type { KnowledgeSource } from '../types/index.js';

export interface ParsedSection {
  title: string;
  content: string;
  level: number;
  metadata: Record<string, unknown>;
}

export interface Frontmatter {
  title?: string;
  tags?: string[];
  domain?: string;
  [key: string]: unknown;
}

/**
 * SPI: Any document parser must implement this interface.
 */
export interface DocumentParser {
  parse(content: string, source: KnowledgeSource): ParsedSection[];
}

/**
 * MarkdownParser — Parses markdown documents into heading-based sections.
 *
 * Extracts YAML frontmatter (---) and splits content by headings.
 * Each heading becomes a ParsedSection with its body content.
 */
/**
 * PlainTextParser — Splits plain text into sections by double-newline paragraphs.
 *
 * Used for plain text, web page content, and pre-converted formats (PDF→text, EPUB→text).
 * Each paragraph becomes a ParsedSection at level 0.
 */
export class PlainTextParser implements DocumentParser {
  parse(content: string, _source: KnowledgeSource): ParsedSection[] {
    const paragraphs = content
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(Boolean);

    if (paragraphs.length === 0) return [];

    return paragraphs.map(paragraph => ({
      title: '',
      content: paragraph,
      level: 0,
      metadata: {},
    }));
  }
}

/**
 * MarkdownParser — Parses markdown documents into heading-based sections.
 *
 * Extracts YAML frontmatter (---) and splits content by headings.
 * Each heading becomes a ParsedSection with its body content.
 */
export class MarkdownParser implements DocumentParser {
  parse(content: string, source: KnowledgeSource): ParsedSection[] {
    const { frontmatter, body } = this.extractFrontmatter(content);
    const sections = this.splitByHeadings(body);

    // Attach frontmatter metadata to all sections
    return sections.map(section => ({
      ...section,
      metadata: { ...frontmatter, ...section.metadata },
    }));
  }

  /**
   * Extract YAML frontmatter delimited by --- lines.
   */
  extractFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
    const fmRegex = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
    const match = content.match(fmRegex);

    if (!match) {
      return { frontmatter: {}, body: content };
    }

    const raw = match[1];
    const frontmatter = this.parseYamlSimple(raw);
    const body = content.slice(match[0].length);

    return { frontmatter, body };
  }

  /**
   * Minimal YAML parser for frontmatter (key: value pairs, arrays with - prefix).
   */
  private parseYamlSimple(raw: string): Frontmatter {
    const data: Record<string, unknown> = {};
    const lines = raw.split('\n');
    let currentKey: string | null = null;
    let currentArray: string[] | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Array item
      if (trimmed.startsWith('- ') && currentKey && currentArray) {
        currentArray.push(trimmed.slice(2).trim());
        continue;
      }

      // Flush previous array
      if (currentKey && currentArray) {
        data[currentKey] = currentArray;
        currentKey = null;
        currentArray = null;
      }

      // Key: value pair
      const kvMatch = trimmed.match(/^([^:]+):\s*(.*)/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();

        if (value === '' || value === '|' || value === '>') {
          // Might be followed by array items
          currentKey = key;
          currentArray = [];
        } else {
          data[key] = value;
        }
      }
    }

    // Flush trailing array
    if (currentKey && currentArray) {
      data[currentKey] = currentArray.length > 0 ? currentArray : '';
    }

    // Normalize tags to array
    const rawTags = data.tags;
    if (typeof rawTags === 'string') {
      data.tags = rawTags.split(',').map((t: string) => t.trim()).filter(Boolean);
    }

    return data as Frontmatter;
  }

  /**
   * Split markdown body into sections by headings.
   * Content before the first heading becomes a level-0 section.
   */
  private splitByHeadings(body: string): ParsedSection[] {
    const sections: ParsedSection[] = [];
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
    let lastIndex = 0;
    let lastTitle = '';
    let lastLevel = 0;
    let match: RegExpExecArray | null;

    // Content before first heading
    const firstMatch = headingRegex.exec(body);
    if (firstMatch) {
      const preamble = body.slice(0, firstMatch.index).trim();
      if (preamble) {
        sections.push({
          title: '',
          content: preamble,
          level: 0,
          metadata: {},
        });
      }
      lastIndex = firstMatch.index + firstMatch[0].length;
      lastTitle = firstMatch[2].trim();
      lastLevel = firstMatch[1].length;
    } else {
      // No headings at all — entire body is one section
      if (body.trim()) {
        sections.push({
          title: '',
          content: body.trim(),
          level: 0,
          metadata: {},
        });
      }
      return sections;
    }

    // Continue finding headings
    while ((match = headingRegex.exec(body)) !== null) {
      const content = body.slice(lastIndex, match.index).trim();
      if (content || lastTitle) {
        sections.push({
          title: lastTitle,
          content,
          level: lastLevel,
          metadata: {},
        });
      }
      lastIndex = match.index + match[0].length;
      lastTitle = match[2].trim();
      lastLevel = match[1].length;
    }

    // Last section
    const remaining = body.slice(lastIndex).trim();
    if (remaining || lastTitle) {
      sections.push({
        title: lastTitle,
        content: remaining,
        level: lastLevel,
        metadata: {},
      });
    }

    return sections;
  }
}
