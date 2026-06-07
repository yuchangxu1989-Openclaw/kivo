/**
 * pdf-vision — Multimodal PDF parsing with vision model fallback.
 *
 * When a PDF page has very little extractable text (<50 chars), it's likely
 * a scanned image or handwritten content. This module renders such pages
 * to images via pdftoppm and sends them to a vision LLM for recognition.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { EntryStatus, KnowledgeType } from '../types/index.js';

export interface PdfVisionConfig {
  /** Vision API base URL (e.g. https://api.penguinsaichat.dpdns.org/) */
  baseUrl: string;
  /** API key for the vision provider */
  apiKey: string;
  /** Vision model ID (e.g. claude-opus-4-6) */
  model: string;
}

export type ImageContentType =
  | 'math_formula'
  | 'flowchart_architecture'
  | 'handwritten_note'
  | 'code_screenshot'
  | 'table_chart'
  | 'lecture_blackboard'
  | 'printed_text'
  | 'mixed'
  | 'unknown';

export interface ImageContentClassification {
  imageType: ImageContentType;
  knowledgeType: KnowledgeType | 'fact+methodology';
  confidence: number;
}

export interface ImageBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionKnowledgeItem {
  title?: string;
  content: string;
  type?: KnowledgeType;
  tags?: string[];
  bbox?: ImageBoundingBox;
  confidence?: number;
  imageType?: ImageContentType;
  knowledgeType?: KnowledgeType | 'fact+methodology';
  status?: EntryStatus;
}

export interface PdfPageResult {
  pageNumber: number;
  text: string;
  source: 'text-extraction' | 'vision-ocr';
  sourceFile?: string;
  parserType: 'vision' | 'text';
  imageRef?: string;
  classification?: ImageContentClassification;
  items: VisionKnowledgeItem[];
  metadata: Record<string, unknown>;
  status: EntryStatus;
}

export interface ParsePdfMultimodalResult {
  pages: PdfPageResult[];
  totalPages: number;
  visionPages: number;
  textPages: number;
}

const VALID_KNOWLEDGE_TYPES = new Set<KnowledgeType>([
  'intent',
  'methodology',
  'fact',
  'experience',
  'decision',
  'meta',
]);

const IMAGE_TYPE_ALIASES: Array<[ImageContentType, string[]]> = [
  ['math_formula', ['math_formula', 'formula', 'derivation', '数学公式', '公式', '推导']],
  ['flowchart_architecture', ['flowchart_architecture', 'flowchart', 'architecture', 'mindmap', '流程图', '架构图', '思维导图']],
  ['handwritten_note', ['handwritten_note', 'handwriting', 'handwritten', '手写', '手写笔记', '笔记']],
  ['code_screenshot', ['code_screenshot', 'code', '代码', '伪代码']],
  ['table_chart', ['table_chart', 'table', 'chart', '数据表格', '表格', '统计图', '柱状图', '折线图', '饼图']],
  ['lecture_blackboard', ['lecture_blackboard', 'blackboard', '板书', '课堂截图', '讲义板书']],
  ['printed_text', ['printed_text', 'text', 'printed', '纯文字', '印刷体', '教材扫描']],
  ['mixed', ['mixed', '混合']],
];

/**
 * Resolve the openclaw.json path in a portable way.
 * Order: OPENCLAW_CONFIG → OPENCLAW_HOME/openclaw.json → $HOME/.openclaw/openclaw.json.
 */
function resolveOpenClawConfigPath(): string {
  if (process.env.OPENCLAW_CONFIG) {
    return process.env.OPENCLAW_CONFIG;
  }
  if (process.env.OPENCLAW_HOME) {
    return join(process.env.OPENCLAW_HOME, 'openclaw.json');
  }
  return join(process.env.HOME || process.env.USERPROFILE || '.', '.openclaw', 'openclaw.json');
}

/**
 * Load vision config from openclaw.json penguin-main provider.
 */
export function loadVisionConfig(): PdfVisionConfig {
  const configPath = resolveOpenClawConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`openclaw.json not found at ${configPath}`);
  }
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
  const pm = cfg?.models?.providers?.['penguin-main'];
  if (!pm?.baseUrl || !pm?.apiKey) {
    throw new Error('penguin-main provider not configured in openclaw.json');
  }
  // Use claude-opus-4-6 which supports image input
  return {
    baseUrl: pm.baseUrl.replace(/\/$/, ''),
    apiKey: pm.apiKey,
    model: 'claude-opus-4-6',
  };
}

function chatCompletionUrl(config: PdfVisionConfig): string {
  let base = config.baseUrl;
  if (!base.endsWith('/v1') && !base.endsWith('/v1/')) {
    base = base.replace(/\/$/, '') + '/v1';
  }
  return `${base.replace(/\/$/, '')}/chat/completions`;
}

async function postChatCompletion(config: PdfVisionConfig, body: Record<string, unknown>, pageNumber: number): Promise<string> {
  const response = await fetch(chatCompletionUrl(config), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Vision API error ${response.status} for page ${pageNumber}: ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`Vision API returned error: ${data.error.message}`);
  }

  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

function stripJsonFence(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  return cleaned;
}

function clampConfidence(value: unknown, fallback = 0.5): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function normalizeImageType(value: unknown): ImageContentType {
  const raw = String(value ?? '').toLowerCase().trim();
  for (const [type, aliases] of IMAGE_TYPE_ALIASES) {
    if (aliases.some((alias) => raw.includes(alias.toLowerCase()))) return type;
  }
  return 'unknown';
}

function normalizeKnowledgeType(value: unknown, imageType?: ImageContentType): KnowledgeType | 'fact+methodology' {
  const raw = String(value ?? '').toLowerCase().trim();
  if (raw.includes('fact') && raw.includes('methodology')) return 'fact+methodology';
  if (raw.includes('方法') && raw.includes('事实')) return 'fact+methodology';
  if (VALID_KNOWLEDGE_TYPES.has(raw as KnowledgeType)) return raw as KnowledgeType;
  if (raw.includes('methodology') || raw.includes('方法')) return 'methodology';
  if (raw.includes('fact') || raw.includes('事实')) return 'fact';

  switch (imageType) {
    case 'flowchart_architecture':
      return 'methodology';
    case 'lecture_blackboard':
      return 'fact+methodology';
    case 'math_formula':
    case 'code_screenshot':
    case 'table_chart':
    case 'printed_text':
    case 'handwritten_note':
    case 'mixed':
    case 'unknown':
    default:
      return 'fact';
  }
}

function normalizeEntryType(value: unknown, fallback: KnowledgeType | 'fact+methodology', content = ''): KnowledgeType {
  const raw = String(value ?? '').toLowerCase().trim();
  if (VALID_KNOWLEDGE_TYPES.has(raw as KnowledgeType)) return raw as KnowledgeType;
  if (fallback === 'methodology') return 'methodology';
  if (fallback === 'fact+methodology') {
    return /方法|步骤|流程|解法|strategy|method|process/i.test(content) ? 'methodology' : 'fact';
  }
  return fallback;
}

function normalizeBBox(value: unknown): ImageBoundingBox | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width ?? raw.w);
  const height = Number(raw.height ?? raw.h);
  if ([x, y, width, height].every(Number.isFinite)) return { x, y, width, height };
  return undefined;
}

export function parseVisionItems(raw: string, fallbackType: KnowledgeType | 'fact+methodology' = 'fact'): VisionKnowledgeItem[] {
  const cleaned = stripJsonFence(raw);
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) {
      const items = parsed.reduce<VisionKnowledgeItem[]>((acc, item) => {
        if (typeof item !== 'object' || item === null) return acc;
        const record = item as Record<string, unknown>;
        const content = String(record.content ?? record.text ?? record.description ?? '').trim();
        if (!content) return acc;
        const type = normalizeEntryType(record.type ?? record.knowledgeType, fallbackType, content);
        acc.push({
          title: typeof record.title === 'string' ? record.title.trim() : undefined,
          content,
          type,
          tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
          bbox: normalizeBBox(record.bbox ?? record.boundingBox),
          confidence: clampConfidence(record.confidence, 0.8),
          imageType: normalizeImageType(record.imageType),
          knowledgeType: normalizeKnowledgeType(record.knowledgeType ?? type),
        });
        return acc;
      }, []);
      if (items.length > 0) return items;
    }
  } catch {
    // Non-JSON response is handled below as a single item.
  }

  return cleaned
    ? [{ content: cleaned, type: normalizeEntryType(undefined, fallbackType, cleaned), confidence: 0.5 }]
    : [];
}

/**
 * Use an LLM to classify the image content after the vision OCR/extraction step.
 */
export async function classifyImageContent(
  config: PdfVisionConfig,
  visionContent: string | VisionKnowledgeItem[],
  pageNumber = 0,
): Promise<ImageContentClassification> {
  const contentForClassification = Array.isArray(visionContent)
    ? visionContent.map((item, index) => `${index + 1}. ${item.title ? `${item.title}: ` : ''}${item.content}`).join('\n')
    : visionContent;

  const prompt = `你要根据视觉模型已经识别出的页面内容，判断原始图片/扫描页的内容类型，并映射为 KIVO 知识类型。

只输出 JSON 对象，不要 markdown 代码块。
字段：
- imageType: math_formula | flowchart_architecture | handwritten_note | code_screenshot | table_chart | lecture_blackboard | printed_text | mixed | unknown
- knowledgeType: fact | methodology | fact+methodology
- confidence: 0 到 1 的数字

映射规则：
- 数学公式/推导 → fact
- 流程图/架构图/思维导图 → methodology
- 手写笔记 → 先按 OCR 后文本内容判断
- 代码截图/伪代码 → fact
- 数据表格/统计图 → fact
- 讲义板书/课堂截图 → 概念定义为 fact，解题方法/步骤为 methodology，整体返回 fact+methodology
- 印刷体纯文字页面 → fact

已识别内容：
${contentForClassification.slice(0, 6000)}`;

  const raw = await postChatCompletion(config, {
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
    temperature: 0,
  }, pageNumber);

  try {
    const parsed = JSON.parse(stripJsonFence(raw)) as Record<string, unknown>;
    const imageType = normalizeImageType(parsed.imageType ?? parsed.type);
    return {
      imageType,
      knowledgeType: normalizeKnowledgeType(parsed.knowledgeType, imageType),
      confidence: clampConfidence(parsed.confidence, 0.5),
    };
  } catch {
    return { imageType: 'unknown', knowledgeType: 'fact', confidence: 0.5 };
  }
}

/**
 * Call vision model API to recognize image content as structured knowledge items.
 */
async function callVisionApi(
  config: PdfVisionConfig,
  imageBase64: string,
  pageNumber: number,
): Promise<VisionKnowledgeItem[]> {
  const body = {
    model: config.model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `请识别这张 PDF 页面图片中的所有知识内容，并拆分为 JSON 数组：每个独立知识点一个对象。

只输出 JSON 数组，不要 markdown 代码块。数组元素字段：
- title: 短标题
- content: 完整知识内容，保持原文语言；公式尽量用 LaTeX；代码还原为可复制文本；表格保留结构化数据点与结论
- type: fact 或 methodology
- tags: 字符串数组
- bbox: {"x":像素左上角x,"y":像素左上角y,"width":宽,"height":高}；无法定位时用整页近似坐标
- confidence: 0 到 1 的数字

要求：
- 单页有多个定理、例题、公式、流程步骤时必须拆成多个数组元素，禁止整页合并成一条。
- 数学公式、表格、代码截图默认 type=fact。
- 流程图、架构图、解题方法步骤默认 type=methodology。
- 手写内容先 OCR 成文本，再按文本内容拆分分类。`,
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${imageBase64}`,
            },
          },
        ],
      },
    ],
    max_tokens: 4096,
    temperature: 0,
  };

  const raw = await postChatCompletion(config, body, pageNumber);
  return parseVisionItems(raw);
}

/**
 * Render a single PDF page to a PNG image using pdftoppm.
 * Returns the base64-encoded PNG and the persistent PNG path.
 */
function renderPageToImage(
  pdfPath: string,
  pageNumber: number,
  tmpDir: string,
  assetDir: string,
): { imageBase64: string; imageRef: string } {
  const outputPrefix = join(tmpDir, `page-${pageNumber}`);
  mkdirSync(assetDir, { recursive: true });

  const result = spawnSync('pdftoppm', [
    '-f', String(pageNumber),
    '-l', String(pageNumber),
    '-png', '-r', '200',
    pdfPath,
    outputPrefix,
  ], { timeout: 30_000 });

  // Check if output file was produced regardless of exit code
  const files = readdirSync(tmpDir) as string[];
  const pageFile = files.find((f: string) => f.startsWith(`page-${pageNumber}`) && f.endsWith('.png'));

  if (pageFile) {
    const content = readFileSync(join(tmpDir, pageFile));
    const imageRef = join(assetDir, `page-${String(pageNumber).padStart(4, '0')}.png`);
    writeFileSync(imageRef, content);
    return { imageBase64: content.toString('base64'), imageRef };
  }

  // If no output and process failed, throw
  const stderr = result.stderr?.toString().trim() || '';
  throw new Error(
    `pdftoppm failed for page ${pageNumber} (exit ${result.status}): ${stderr.slice(0, 150)}`,
  );
}

function buildPageMetadata(args: {
  sourceFile: string;
  pageNumber: number;
  parserType: 'vision' | 'text';
  imageRef?: string;
  classification?: ImageContentClassification;
  bbox?: ImageBoundingBox;
  itemIndex?: number;
}): Record<string, unknown> {
  return {
    sourcePage: args.pageNumber,
    sourceFile: args.sourceFile,
    parserType: args.parserType,
    imageRef: args.imageRef ?? null,
    imageType: args.classification?.imageType,
    knowledgeType: args.classification?.knowledgeType,
    classificationConfidence: args.classification?.confidence,
    boundingBox: args.bbox,
    extractionItemIndex: args.itemIndex,
  };
}

/**
 * Parse a PDF with multimodal support.
 * Pages with sufficient text use standard text extraction.
 * Pages with <50 chars of text are rendered to images and sent to vision model.
 */
export async function parsePdfMultimodal(
  pdfBytes: Uint8Array,
  options?: {
    config?: PdfVisionConfig;
    onProgress?: (msg: string) => void;
    sourceFile?: string;
    assetDir?: string;
  },
): Promise<ParsePdfMultimodalResult> {
  const config = options?.config ?? loadVisionConfig();
  const log = options?.onProgress ?? console.log;

  // Write PDF to temp file for pdftoppm BEFORE pdfjs consumes the buffer
  // (pdfjs.getDocument transfers/detaches the ArrayBuffer, zeroing the original)
  const tmpDir = join('/tmp', `kivo-pdf-vision-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  const tmpPdfPath = join(tmpDir, 'input.pdf');
  writeFileSync(tmpPdfPath, pdfBytes);
  const sourceFile = options?.sourceFile ?? tmpPdfPath;
  const assetDir = options?.assetDir ?? join('/tmp', `kivo-pdf-vision-assets-${randomUUID()}`);

  // Import pdfjs for text extraction
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: pdfBytes }).promise;
  const totalPages = doc.numPages;

  const pages: PdfPageResult[] = [];
  let visionPages = 0;
  let textPages = 0;

  try {
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      // First try text extraction
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? (item as { str: string }).str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (text.length >= 50) {
        // Sufficient text — use text extraction
        const metadata = buildPageMetadata({ sourceFile, pageNumber, parserType: 'text' });
        pages.push({
          pageNumber,
          text,
          source: 'text-extraction',
          sourceFile,
          parserType: 'text',
          items: [{ content: text, type: 'fact', confidence: 0.8 }],
          metadata,
          status: 'active',
        });
        textPages++;
      } else {
        // Sparse text — use vision model
        log(`  Page ${pageNumber}/${totalPages}: sparse text (${text.length} chars), using vision model...`);
        try {
          const { imageBase64, imageRef } = renderPageToImage(tmpPdfPath, pageNumber, tmpDir, assetDir);
          const visionItems = await callVisionApi(config, imageBase64, pageNumber);
          const classification = await classifyImageContent(config, visionItems, pageNumber);
          const pageStatus: EntryStatus = classification.confidence < 0.7 ? 'pending' : 'active';
          const items = visionItems.map((item, index) => {
            const itemConfidence = item.confidence ?? classification.confidence;
            const itemStatus: EntryStatus = Math.min(itemConfidence, classification.confidence) < 0.7 ? 'pending' : pageStatus;
            return {
              ...item,
              type: normalizeEntryType(item.type, classification.knowledgeType, item.content),
              imageType: item.imageType && item.imageType !== 'unknown' ? item.imageType : classification.imageType,
              knowledgeType: item.knowledgeType ?? classification.knowledgeType,
              confidence: itemConfidence,
              status: itemStatus,
              bbox: item.bbox,
              tags: item.tags,
              title: item.title,
              content: item.content,
            } satisfies VisionKnowledgeItem;
          });
          const visionText = items.map((item) => item.content).join('\n\n');

          if (items.length > 0 && visionText.length > 0) {
            const metadata = buildPageMetadata({
              sourceFile,
              pageNumber,
              parserType: 'vision',
              imageRef,
              classification,
            });
            pages.push({
              pageNumber,
              text: visionText,
              source: 'vision-ocr',
              sourceFile,
              parserType: 'vision',
              imageRef,
              classification,
              items,
              metadata,
              status: pageStatus,
            });
            visionPages++;
            log(`  Page ${pageNumber}: vision extracted ${items.length} item(s), ${visionText.length} chars`);
          } else {
            // Vision returned nothing — keep page in review queue with source image.
            const metadata = buildPageMetadata({
              sourceFile,
              pageNumber,
              parserType: 'vision',
              imageRef,
              classification,
            });
            pages.push({
              pageNumber,
              text: text || '[vision returned empty]',
              source: 'vision-ocr',
              sourceFile,
              parserType: 'vision',
              imageRef,
              classification,
              items: [{ content: text || '[vision returned empty]', type: 'fact', confidence: 0.5, status: 'pending' }],
              metadata,
              status: 'pending',
            });
            visionPages++;
            log(`  Page ${pageNumber}: vision returned empty, queued for review`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`  Page ${pageNumber}: vision failed: ${msg}`);
          // If there was some text, use it anyway
          if (text.length > 0) {
            const metadata = buildPageMetadata({ sourceFile, pageNumber, parserType: 'text' });
            pages.push({
              pageNumber,
              text,
              source: 'text-extraction',
              sourceFile,
              parserType: 'text',
              items: [{ content: text, type: 'fact', confidence: 0.5, status: 'pending' }],
              metadata,
              status: 'pending',
            });
            textPages++;
          }
        }
      }
    }
  } finally {
    // Cleanup temp files only. Page PNGs were copied to assetDir and intentionally preserved.
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }
  }

  return { pages, totalPages, visionPages, textPages };
}
