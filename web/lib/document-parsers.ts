import type { ImportCandidate, SourceContextParagraph, SourceRange } from './import-types';

type ParsedPdfPage = {
  pageNumber: number;
  text: string;
};

function normalizeText(raw: string) {
  return raw.replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function inferCandidateType(block: string) {
  if (/定理|theorem/i.test(block)) return 'fact';
  if (/例题|例\s*\d+|example/i.test(block)) return 'methodology';
  if (/定义|definition/i.test(block)) return 'fact';
  if (/证明|proof/i.test(block)) return 'methodology';
  if (/[=≈∑∫π√]|\\frac|\\sum|\\int/.test(block)) return 'fact';
  return 'fact';
}

function toLatexBlock(block: string) {
  if (/[=≈∑∫π√]/.test(block) && !/\$\$/.test(block)) {
    return `$$${block}$$`;
  }
  return block;
}

function splitParagraphs(text: string): string[] {
  const parts = text
    .split(/\n\s*\n|\r\n\s*\r\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text.trim()].filter(Boolean);
}

function buildSourceParagraphs(
  paragraphs: string[],
  startIndex: number,
  endIndex: number,
  contextSize = 2,
): SourceContextParagraph[] {
  if (paragraphs.length === 0) return [];
  const start = Math.max(0, startIndex - contextSize);
  const end = Math.min(paragraphs.length - 1, endIndex + contextSize);
  return paragraphs.slice(start, end + 1).map((text, offset) => {
    const index = start + offset;
    return { index: index + 1, text, highlighted: index >= startIndex && index <= endIndex };
  });
}

function sourceRange(
  kind: SourceRange['kind'],
  start: number,
  end = start,
  extras: Partial<Omit<SourceRange, 'kind' | 'start' | 'end'>> = {},
): SourceRange {
  return { kind, start, end, ...extras };
}

function extractStructuredBlocks(page: ParsedPdfPage, fileName: string, totalPages: number): ImportCandidate[] {
  const sections = page.text
    .split(/\n\s*\n/)
    .map((block) => normalizeText(block))
    .filter((block) => block.length >= 18);

  const candidates: ImportCandidate[] = [];
  let localIndex = 0;

  for (const block of sections) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const header = lines[0] || `第 ${page.pageNumber} 页内容`;
    const title = header.length <= 42 ? header : `${header.slice(0, 42)}…`;
    const kind = /定义|definition/i.test(block)
      ? '定义'
      : /定理|theorem/i.test(block)
        ? '定理'
        : /例题|example/i.test(block)
          ? '例题'
          : (/[=≈∑∫π√]|\\frac|\\sum|\\int/.test(block) ? '公式' : '知识点');
    const paragraph = String(localIndex + 1);
    localIndex += 1;

    candidates.push({
      id: `pdf-${page.pageNumber}-${String(localIndex).padStart(2, '0')}`,
      type: inferCandidateType(block),
      title: `${kind} · ${title}`,
      content: toLatexBlock(block),
      sourceAnchor: `第 ${page.pageNumber} 页 · 第 ${paragraph} 段`,
      sourceContext: block,
      sourceDocument: fileName,
      sourceLocation: `第 ${page.pageNumber} 页 / 第 ${paragraph} 段 / 共 ${totalPages} 页`,
      sourceRange: sourceRange('paragraph', localIndex, localIndex, {
        documentId: fileName,
        page: page.pageNumber,
        paragraph: localIndex,
        section: `${kind} · ${title}`,
        originalText: block,
      }),
      sourceParagraphs: [{ index: localIndex, text: block, highlighted: true }],
      status: 'pending',
    });
  }

  return candidates;
}

async function parsePdfPages(file: File): Promise<ParsedPdfPage[]> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/kivo/pdf.worker.min.mjs';

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages: ParsedPdfPage[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
      .map((item) => item.str)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (text) {
      pages.push({ pageNumber: i, text });
    }
  }

  return pages;
}

export async function parsePdfFile(file: File): Promise<ImportCandidate[]> {
  const pages = await parsePdfPages(file);
  if (pages.length === 0) return [];

  const structured = pages.flatMap((page) => extractStructuredBlocks(page, file.name, pages.length));
  if (structured.length > 0) return structured;

  return pages.map((page, index) => ({
    id: `cand-${String(index + 1).padStart(3, '0')}`,
    type: 'fact',
    title: `${file.name.replace(/\.[^.]+$/, '')} - 第${page.pageNumber}页`,
    content: page.text,
    sourceAnchor: `第 ${page.pageNumber} 页`,
    sourceContext: page.text,
    sourceDocument: file.name,
    sourceLocation: `第 ${page.pageNumber} 页 / 共 ${pages.length} 页`,
    sourceRange: sourceRange('page', page.pageNumber, page.pageNumber, {
      documentId: file.name,
      page: page.pageNumber,
      section: `第 ${page.pageNumber} 页`,
      originalText: page.text,
    }),
    sourceParagraphs: [{ index: page.pageNumber, text: page.text, highlighted: true }],
    status: 'pending',
  }));
}

export async function parseEpubFile(file: File): Promise<ImportCandidate[]> {
  const JSZip = (await import('jszip')).default;
  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);

  const htmlFiles: { path: string; content: string }[] = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (/\.(xhtml|html|htm)$/i.test(path)) {
      const text = await entry.async('text');
      htmlFiles.push({ path, content: text });
    }
  }

  htmlFiles.sort((a, b) => a.path.localeCompare(b.path));
  const sections = htmlFiles
    .map(({ path, content }) => ({
      path,
      text: normalizeText(
        content
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"'),
      ),
    }))
    .filter((section) => section.text.length >= 20);

  return sections.map((section, index) => ({
    id: `cand-${String(index + 1).padStart(3, '0')}`,
    type: 'fact',
    title: `${file.name.replace(/\.[^.]+$/, '')} - 章节${index + 1}`,
    content: section.text,
    sourceAnchor: `章节 ${index + 1}`,
    sourceContext: section.text,
    sourceDocument: file.name,
    sourceLocation: `${section.path} / 第 ${index + 1} 章`,
    sourceRange: sourceRange('chapter', index + 1, index + 1, {
      documentId: file.name,
      paragraph: index + 1,
      section: `${section.path} / 第 ${index + 1} 章`,
      originalText: section.text,
    }),
    sourceParagraphs: buildSourceParagraphs(sections.map(item => item.text), index, index),
    status: 'pending',
  }));
}

export function parsePlainTextFile(file: File, text: string): ImportCandidate[] {
  const paragraphs = splitParagraphs(text);
  const sourceParagraphs = paragraphs.map((paragraph, index) => ({ index: index + 1, text: paragraph, highlighted: true }));
  return [{
    id: 'cand-001',
    type: 'fact',
    title: file.name.replace(/\.[^.]+$/, ''),
    content: text.trim(),
    sourceAnchor: paragraphs.length > 1 ? `第 1-${paragraphs.length} 段` : '第 1 段',
    sourceContext: paragraphs.join('\n\n'),
    sourceDocument: file.name,
    sourceLocation: paragraphs.length > 1 ? `第 1-${paragraphs.length} 段` : '第 1 段',
    sourceRange: sourceRange('paragraph', 1, Math.max(1, paragraphs.length), {
      documentId: file.name,
      paragraph: { start: 1, end: Math.max(1, paragraphs.length) },
      section: paragraphs.length > 1 ? `第 1-${paragraphs.length} 段` : '第 1 段',
      originalText: paragraphs.join('\n\n'),
    }),
    sourceParagraphs,
    status: 'pending',
  }];
}
