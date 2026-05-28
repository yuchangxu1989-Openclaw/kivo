/**
 * kivo ingest-pdf — Parse PDF files and extract knowledge entries into the DB.
 *
 * Uses pdfjs-dist to extract text from PDF, then feeds through the standard
 * LLM semantic extraction pipeline (ingest-core).
 *
 * Embedding is deferred to batch vectorization (embed-backfill).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { DEFAULT_CONFIG } from '../config/types.js';
import { parsePdf, PlainTextParser } from '../extraction/document-parser.js';
import { parsePdfMultimodal, loadVisionConfig } from '../extraction/pdf-vision.js';
import { runIngestCore } from './ingest-core.js';

export interface IngestPdfOptions {
  /** PDF file paths to process */
  files: string[];
  /** Target knowledge domain, for example a project name or topic label */
  domain?: string;
  /** Working directory (defaults to cwd) */
  cwd?: string;
  /** Output JSON format */
  json?: boolean;
  /** Skip FR-N05 quality gate */
  noQualityGate?: boolean;
  /** Enable multimodal vision for image-heavy pages */
  multimodal?: boolean;
}

function resolveDbPath(dir: string): string {
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);
  if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }
  return resolve(dir, dbPath);
}

/**
 * Convert PDF text into a temporary markdown file for ingest-core processing.
 * Adds frontmatter with domain metadata if specified.
 */
function pdfTextToMarkdown(text: string, pdfName: string, domain?: string): string {
  const lines: string[] = [];

  // Add frontmatter
  lines.push('---');
  lines.push(`title: ${pdfName}`);
  if (domain) {
    lines.push(`domain: ${domain}`);
    lines.push(`tags:`);
    lines.push(`- ${domain}`);
  }
  lines.push(`source: pdf-import`);
  lines.push('---');
  lines.push('');

  // Split text into paragraphs and add as markdown sections
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);

  // Group paragraphs into logical sections (~2000 chars each for better LLM extraction)
  let currentSection = '';
  let sectionIndex = 0;

  for (const para of paragraphs) {
    if (currentSection.length + para.length > 2000 && currentSection.length > 0) {
      sectionIndex++;
      lines.push(`## Section ${sectionIndex}`);
      lines.push('');
      lines.push(currentSection.trim());
      lines.push('');
      currentSection = '';
    }
    currentSection += para + '\n\n';
  }

  // Flush remaining
  if (currentSection.trim().length > 0) {
    sectionIndex++;
    lines.push(`## Section ${sectionIndex}`);
    lines.push('');
    lines.push(currentSection.trim());
    lines.push('');
  }

  return lines.join('\n');
}

export async function runIngestPdf(options: IngestPdfOptions): Promise<string> {
  const dir = resolve(options.cwd ?? process.cwd());
  const dbPath = resolveDbPath(dir);

  if (!existsSync(dbPath)) {
    return options.json
      ? JSON.stringify({ error: 'Database not found. Run `kivo init` first.', path: dbPath })
      : `✗ Database not found at ${dbPath}. Run \`kivo init\` first.`;
  }

  const { files, domain } = options;

  if (!files || files.length === 0) {
    return options.json
      ? JSON.stringify({ error: 'No PDF files specified.' })
      : '✗ No PDF files specified. Use --files <path1,path2,...>';
  }

  // Validate all files exist
  const resolvedFiles: string[] = [];
  for (const f of files) {
    const resolved = resolve(f);
    if (!existsSync(resolved)) {
      return options.json
        ? JSON.stringify({ error: `File not found: ${f}` })
        : `✗ File not found: ${f}`;
    }
    if (!resolved.toLowerCase().endsWith('.pdf')) {
      return options.json
        ? JSON.stringify({ error: `Not a PDF file: ${f}` })
        : `✗ Not a PDF file: ${f}`;
    }
    resolvedFiles.push(resolved);
  }

  console.log(`Processing ${resolvedFiles.length} PDF file(s)...`);
  if (domain) console.log(`Target domain: ${domain}`);

  // Convert PDFs to temporary markdown files
  const tmpDir = resolve(dir, '.tmp-pdf-ingest');
  const { mkdirSync, rmSync } = await import('node:fs');
  mkdirSync(tmpDir, { recursive: true });

  const mdFiles: string[] = [];
  const sourceReferences: Record<string, string> = {};

  try {
    for (const pdfPath of resolvedFiles) {
      const pdfName = basename(pdfPath, '.pdf');
      console.log(`Parsing PDF: ${pdfName}...`);

      const pdfBytes = new Uint8Array(readFileSync(pdfPath));
      let text: string;
      let pageMetadataBySection: Record<string, Record<string, unknown>> | undefined;
      let pageStatusBySection: Record<string, string> | undefined;
      let pageConfidenceBySection: Record<string, number> | undefined;
      let pageTypeBySection: Record<string, string> | undefined;
      let pageTagsBySection: Record<string, string[]> | undefined;

      if (options.multimodal) {
        // Multimodal mode: use vision model for image-heavy pages
        try {
          const visionConfig = loadVisionConfig();
          const importId = `${pdfName}-${Date.now()}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
          const assetDir = join(dir, '.kivo', 'assets', 'imports', importId);
          const result = await parsePdfMultimodal(pdfBytes, {
            config: visionConfig,
            onProgress: (msg) => console.log(msg),
            sourceFile: pdfPath,
            assetDir,
          });

          if (result.pages.length === 0) {
            console.log(`  ⚠ PDF ${pdfName}: no content extracted (${result.totalPages} pages), skipping.`);
            continue;
          }

          const markdownParts: string[] = [];
          pageMetadataBySection = {};
          pageStatusBySection = {};
          pageConfidenceBySection = {};
          pageTypeBySection = {};
          pageTagsBySection = {};

          for (const pageResult of result.pages) {
            pageResult.items.forEach((item, itemIndex) => {
              const sectionTitle = `Page ${pageResult.pageNumber} Item ${itemIndex + 1}`;
              const metadata = {
                ...pageResult.metadata,
                sourcePage: pageResult.pageNumber,
                sourceFile: pdfPath,
                parserType: pageResult.parserType,
                imageRef: pageResult.imageRef ?? null,
                imageType: item.imageType ?? pageResult.classification?.imageType,
                knowledgeType: item.knowledgeType ?? pageResult.classification?.knowledgeType,
                classificationConfidence: pageResult.classification?.confidence,
                extractionConfidence: item.confidence,
                boundingBox: item.bbox,
                extractionItemIndex: itemIndex + 1,
              };
              pageMetadataBySection![sectionTitle] = metadata;
              pageStatusBySection![sectionTitle] = item.status ?? pageResult.status;
              pageConfidenceBySection![sectionTitle] = item.confidence ?? pageResult.classification?.confidence ?? 0.8;
              pageTypeBySection![sectionTitle] = item.type ?? 'fact';
              pageTagsBySection![sectionTitle] = item.tags ?? [];

              markdownParts.push(`## ${sectionTitle}\n\n${item.content}`);
            });
          }

          text = markdownParts.join('\n\n');
          console.log(
            `  Extracted ${text.length} chars from ${pdfName} ` +
            `(${result.textPages} text pages, ${result.visionPages} vision pages)`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  ✗ Failed multimodal parse of ${pdfName}: ${msg}`);
          continue;
        }
      } else {
        // Standard text-only mode
        try {
          text = await parsePdf(pdfBytes);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  ✗ Failed to parse PDF ${pdfName}: ${msg}`);
          continue;
        }

        if (text.trim().length < 50) {
          console.log(`  ⚠ PDF ${pdfName} has very little text (${text.length} chars), skipping.`);
          continue;
        }

        console.log(`  Extracted ${text.length} chars from ${pdfName}`);
      }

      // Convert to markdown for ingest-core
      const mdContent = options.multimodal ? text : pdfTextToMarkdown(text, pdfName, domain);
      const mdPath = join(tmpDir, `${pdfName}.md`);
      writeFileSync(mdPath, mdContent, 'utf-8');
      mdFiles.push(mdPath);
      sourceReferences[mdPath] = `file://${pdfPath}`;
      if (pageMetadataBySection || pageStatusBySection || pageConfidenceBySection || pageTypeBySection || pageTagsBySection) {
        const sidecarPath = `${mdPath}.kivo-metadata.json`;
        writeFileSync(sidecarPath, JSON.stringify({
          metadataBySection: pageMetadataBySection ?? {},
          statusBySection: pageStatusBySection ?? {},
          confidenceBySection: pageConfidenceBySection ?? {},
          typeBySection: pageTypeBySection ?? {},
          tagsBySection: pageTagsBySection ?? {},
        }, null, 2), 'utf-8');
      }
    }

    if (mdFiles.length === 0) {
      return options.json
        ? JSON.stringify({ error: 'No PDF files could be parsed successfully.' })
        : '✗ No PDF files could be parsed successfully.';
    }

    // Run through ingest-core pipeline
    console.log(`Running LLM extraction on ${mdFiles.length} converted file(s)...`);
    const result = await runIngestCore({
      dir,
      dbPath,
      mdFiles,
      sourceReferences,
      json: options.json,
      noQualityGate: !!options.noQualityGate,
    });

    const summary = `✓ [PDF→LLM] Ingested ${result.extracted} knowledge entries from ${resolvedFiles.length} PDF file(s)` +
      (domain ? ` (domain: ${domain})` : '') +
      (result.skipped > 0 ? ` (${result.skipped} skipped)` : '');

    if (options.json) {
      return JSON.stringify({
        mode: 'pdf-llm',
        extracted: result.extracted,
        deduped: result.deduped,
        skipped: result.skipped,
        files: resolvedFiles.length,
        domain: domain ?? null,
        details: result.details,
      });
    }

    return [summary, ...result.details].join('\n');
  } finally {
    // Clean up temp files
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }
  }
}
