import type { ImportCandidate } from './import-types';

export async function parsePdfFile(file: File): Promise<ImportCandidate[]> {
  const pdfjsLib = await import('pdfjs-dist');
  // Use CDN worker to avoid webpack bundling issues with ESM worker file
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
      .map((item) => item.str)
      .join('');
    if (text.trim()) pages.push(text.trim());
  }

  const fullText = pages.join('\n\n');
  if (!fullText.trim()) return [];

  const name = file.name.replace(/\.[^.]+$/, '');
  return [{
    id: 'cand-001',
    type: 'fact',
    title: name,
    content: fullText,
    sourceAnchor: `${file.name} (${pdf.numPages} 页)`,
    status: 'pending',
  }];
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

  const sections: string[] = [];
  for (const { content } of htmlFiles) {
    const text = content
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 20) sections.push(text);
  }

  const fullText = sections.join('\n\n');
  if (!fullText.trim()) return [];

  const name = file.name.replace(/\.[^.]+$/, '');
  return [{
    id: 'cand-001',
    type: 'fact',
    title: name,
    content: fullText,
    sourceAnchor: `${file.name} (${sections.length} 章节)`,
    status: 'pending',
  }];
}
