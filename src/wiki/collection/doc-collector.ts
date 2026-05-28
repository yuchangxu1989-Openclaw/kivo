/**
 * FR-1 AC-1.2, AC-1.7, NFR-1
 * Document collection: parse Markdown/PDF/plain text, then convert into a wiki draft through the LLM.
 */

import { buildDraft } from './url-collector.js';
import type { CollectorContext, DocumentCollectInput, WikiCollectionResult } from '../types.js';

export class DocCollector {
  async collect(input: DocumentCollectInput, context: CollectorContext): Promise<WikiCollectionResult> {
    const startedAt = Date.now();
    const normalized = await normalizeDocument(input);
    const draft = await buildDraft(
      {
        title: normalized.title,
        content: normalized.content,
        spaceId: input.spaceId,
        source: {
          type: 'document',
          fileName: input.fileName,
          mimeType: normalized.mimeType,
          collectedAt: (context.now ?? new Date()).toISOString(),
        },
      },
      context,
    );
    return {
      draft,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function normalizeDocument(input: DocumentCollectInput): Promise<{ title: string; content: string; mimeType: string }> {
  const mimeType = (input.mimeType ?? detectMimeType(input.fileName)).toLowerCase();
  if (mimeType.includes('markdown') || input.fileName.endsWith('.md')) {
    const content = typeof input.content === 'string' ? input.content : new TextDecoder().decode(input.content);
    return {
      title: extractMarkdownTitle(content, input.fileName),
      content,
      mimeType,
    };
  }
  if (mimeType === 'text/plain' || input.fileName.endsWith('.txt')) {
    const content = typeof input.content === 'string' ? input.content : new TextDecoder().decode(input.content);
    return {
      title: input.fileName.replace(/\.[^.]+$/, ''),
      content,
      mimeType,
    };
  }
  if (mimeType === 'application/pdf' || input.fileName.endsWith('.pdf')) {
    const bytes = typeof input.content === 'string' ? new TextEncoder().encode(input.content) : input.content;
    const content = await parsePdf(bytes);
    return {
      title: input.fileName.replace(/\.pdf$/i, ''),
      content,
      mimeType: 'application/pdf',
    };
  }
  throw new Error(`Unsupported document format: ${input.fileName} (${mimeType})`);
}

function detectMimeType(fileName: string): string {
  if (fileName.endsWith('.md')) return 'text/markdown';
  if (fileName.endsWith('.txt')) return 'text/plain';
  if (fileName.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

function extractMarkdownTitle(content: string, fallback: string): string {
  const firstHeading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return firstHeading || fallback.replace(/\.[^.]+$/, '');
}

async function parsePdf(bytes: Uint8Array): Promise<string> {
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
