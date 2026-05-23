/**
 * FR-1 AC-1.2, NFR-1
 * PDF parsing: extract per-page text and document metadata using pdfjs-dist.
 */

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

export async function parsePdfDocument(data: Uint8Array): Promise<PdfParseResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
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
      .map((item) => ('str' in item ? item.str : ''))
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
