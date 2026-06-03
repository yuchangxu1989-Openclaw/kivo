/**
 * FR-1 AC-1.2, NFR-1
 * PDF parsing: extract per-page text and document metadata using pdfjs-dist.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export interface PdfPage {
  pageNumber: number;
  text: string;
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  pageCount: number;
}

export interface PdfParseResult {
  pages: PdfPage[];
  metadata: PdfMetadata;
}

let cachedWorkerSrc: string | null | undefined;

function resolveWorkerSrc(): string | null {
  if (cachedWorkerSrc !== undefined) return cachedWorkerSrc;
  // pdf.js default workerSrc is the relative string './pdf.worker.mjs', which fails
  // when the consumer is bundled (e.g. Next.js chunks under .next/server/chunks/).
  // Resolve the worker absolutely against the actually-installed pdfjs-dist so the
  // fake-worker dynamic import succeeds regardless of cwd.
  try {
    const require = createRequire(`${process.cwd()}/package.json`);
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    cachedWorkerSrc = pathToFileURL(workerPath).href;
  } catch {
    cachedWorkerSrc = null;
  }
  return cachedWorkerSrc;
}

export async function parsePdfDocument(data: Uint8Array): Promise<PdfParseResult> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const workerSrc = resolveWorkerSrc();
  if (workerSrc && pdfjs?.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  }
  const doc = await pdfjs.getDocument({ data }).promise;

  const info = await doc.getMetadata().catch(() => null);
  const metadata: PdfMetadata = {
    pageCount: doc.numPages,
    title: extractInfoField(info, 'Title'),
    author: extractInfoField(info, 'Author'),
  };

  const pages: PdfPage[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item: any) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    pages.push({ pageNumber, text });
  }

  return { pages, metadata };
}

function extractInfoField(info: unknown, key: string): string | undefined {
  if (!info || typeof info !== 'object') return undefined;
  const record = info as Record<string, unknown>;
  const infoDict = record.info as Record<string, unknown> | undefined;
  if (!infoDict || typeof infoDict !== 'object') return undefined;
  const value = infoDict[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
