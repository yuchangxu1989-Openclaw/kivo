/**
 * DocumentParser — SPI interface + MarkdownParser implementation.
 *
 * Parses structured documents into sections for downstream extraction.
 * Supports frontmatter metadata extraction and heading-based sectioning.
 */

import type { KnowledgeSource } from '../types/index.js';
import JSZip from 'jszip';

export interface ParsedSection {
  title: string;
  content: string;
  level: number;
  metadata: Record<string, unknown>;
  /** Original document location for this parsed section. */
  sourceRange?: {
    documentId: string;
    page?: number;
    paragraph?: number | { start: number; end: number };
    section?: string;
    originalText: string;
  };
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

export async function parsePdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const parts: string[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (line) {
      parts.push(line);
    }
  }

  return parts.join('\n\n');
}

export async function parseEpub(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const containerXml = await readRequiredZipText(zip, 'META-INF/container.xml');
  const packagePath = readFullPathFromContainer(containerXml);
  const packageXml = await readRequiredZipText(zip, packagePath);
  const manifest = readManifest(packageXml);
  const spine = readSpine(packageXml);
  const baseDir = packagePath.includes('/') ? packagePath.slice(0, packagePath.lastIndexOf('/') + 1) : '';
  const chapters: string[] = [];

  for (const id of spine) {
    const href = manifest.get(id);
    if (!href) {
      continue;
    }

    const chapterPath = normalizeZipPath(`${baseDir}${href}`);
    const chapter = await zip.file(chapterPath)?.async('string');
    if (!chapter) {
      continue;
    }

    const text = htmlToText(chapter);
    if (text) {
      chapters.push(text);
    }
  }

  if (chapters.length === 0) {
    throw new Error('EPUB contains no readable chapter content');
  }

  return chapters.join('\n\n');
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
  parse(content: string, source: KnowledgeSource): ParsedSection[] {
    const paragraphs = content
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(Boolean);

    if (paragraphs.length === 0) return [];

    return paragraphs.map((paragraph, index) => ({
      title: '',
      content: paragraph,
      level: 0,
      metadata: {},
      sourceRange: {
        documentId: source.reference,
        paragraph: index + 1,
        originalText: paragraph,
      },
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
      sourceRange: section.sourceRange
        ? { ...section.sourceRange, documentId: source.reference }
        : undefined,
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
          sourceRange: {
            documentId: '',
            section: '',
            originalText: preamble,
          },
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
          sourceRange: {
            documentId: '',
            section: '',
            originalText: body.trim(),
          },
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
          sourceRange: {
            documentId: '',
            section: lastTitle,
            originalText: content,
          },
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
        sourceRange: {
          documentId: '',
          section: lastTitle,
          originalText: remaining,
        },
      });
    }

    return sections;
  }
}

function normalizeZipPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
}

async function readRequiredZipText(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(normalizeZipPath(path));
  if (!entry) {
    throw new Error(`EPUB missing required file: ${path}`);
  }

  return entry.async('string');
}

function readFullPathFromContainer(containerXml: string): string {
  const match = containerXml.match(/full-path="([^"]+)"/i);
  if (!match?.[1]) {
    throw new Error('EPUB container.xml missing package path');
  }
  return match[1];
}

function readManifest(packageXml: string): Map<string, string> {
  const manifest = new Map<string, string>();
  const itemRegex = /<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"[^>]*\/?>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(packageXml)) !== null) {
    manifest.set(match[1], match[2]);
  }

  return manifest;
}

function readSpine(packageXml: string): string[] {
  const ids: string[] = [];
  const itemRefRegex = /<itemref\b[^>]*\bidref="([^"]+)"[^>]*\/?>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRefRegex.exec(packageXml)) !== null) {
    ids.push(match[1]);
  }

  return ids;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
