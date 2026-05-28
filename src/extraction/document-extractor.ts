import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../adapter/llm-provider.js';
import { Classifier } from '../pipeline/classifier.js';
import type { KnowledgeEntry, KnowledgeSource, KnowledgeType, SourceRange } from '../types/index.js';
import { ChunkStrategy, type ChunkOptions } from './chunk-strategy.js';
import { MarkdownParser, PlainTextParser, type DocumentParser, type ParsedSection } from './document-parser.js';
import {
  buildDerivedSource,
  clampConfidence,
  dedupeKey,
  extractJsonBlock,
  generateSummary,
  generateTitle,
  isDuplicateEntry,
  isKnowledgeType,
  normalizeKnowledgeCandidates,
  shortenKnowledgeTitle,
  uniqueTags,
} from './extraction-utils.js';
import { createAnalysisArtifact, type AnalysisArtifact, type CandidateEntity } from './analysis-artifact.js';

export interface DocumentExtractionResult {
  entries: KnowledgeEntry[];
  artifact: AnalysisArtifact;
}

export interface DocumentMetadata {
  path: string;
  title?: string;
}

export type DocumentLLMProvider = LLMProvider;

export interface DocumentExtractorOptions {
  /** Minimum content length to consider a section extractable */
  minContentLength?: number;
  /** Minimum confidence threshold (retained for scoring; all entries are 'active') */
  minConfidence?: number;
  /** Custom classifier instance */
  classifier?: Classifier;
  /** Optional LLM provider for semantic extraction */
  llmProvider?: DocumentLLMProvider;
  /** Optional parser override */
  parser?: DocumentParser;
  /** Optional chunk strategy override */
  chunkStrategy?: ChunkStrategy;
  /** Chunk settings used when llmProvider is present */
  chunkOptions?: ChunkOptions;
}

interface CandidateInput {
  type?: string;
  title?: string;
  content?: string;
  summary?: string;
  confidence?: number;
  tags?: string[];
  similar_sentences?: string[];
  similarSentences?: string[];
}

export class DocumentExtractor {
  private classifier: Classifier;
  private minContentLength: number;
  private minConfidence: number;
  private llmProvider?: DocumentLLMProvider;
  private parser: DocumentParser;
  private chunkStrategy: ChunkStrategy;

  constructor(options: DocumentExtractorOptions = {}) {
    this.classifier = options.classifier ?? new Classifier();
    this.minContentLength = options.minContentLength ?? 10;
    this.minConfidence = options.minConfidence ?? 0.3;
    this.llmProvider = options.llmProvider;
    this.parser = options.parser ?? new MarkdownParser();
    this.chunkStrategy = options.chunkStrategy ?? new ChunkStrategy(options.chunkOptions);
  }

  /**
   * Extract KnowledgeEntry[] from parsed sections.
   * Each section with sufficient content becomes one entry.
   */
  async extract(sections: ParsedSection[], source: KnowledgeSource): Promise<KnowledgeEntry[]> {
    const entries: KnowledgeEntry[] = [];

    for (const section of sections) {
      const fullContent = section.title
        ? `${section.title}\n${section.content}`
        : section.content;

      if (fullContent.trim().length < this.minContentLength) continue;

      const { type, confidence } = await this.classifier.classify(fullContent);
      const resolvedType = this.resolveType(type, section);
      const now = new Date();

      const tags = this.extractTags(section);
      const domain = this.extractDomain(section);

      const sourceRange = normalizeSourceRange(section.sourceRange, source.reference, section.title || undefined, fullContent);

      const adjustedConfidence = Math.max(confidence, this.minConfidence);

      entries.push({
        id: randomUUID(),
        type: resolvedType,
        title: section.title || this.generateTitle(section.content),
        content: section.content,
        summary: this.generateSummary(section.content),
        source,
        sourceRange,
        confidence: adjustedConfidence,
        status: 'active',
        tags,
        domain,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
    }

    return entries;
  }

  async extractFromMarkdown(
    markdown: string,
    metadata: DocumentMetadata,
    source: KnowledgeSource,
    existingEntries: KnowledgeEntry[] = [],
  ): Promise<KnowledgeEntry[]> {
    const sections = this.parser.parse(markdown, source);

    if (!this.llmProvider) {
      return this.dedupeEntries(await this.extract(sections, source), existingEntries);
    }

    const chunks = this.chunkStrategy.chunkSectionsByTokenBudget(sections);
    const dedupe = new Set(existingEntries.map(entry => dedupeKey(entry.type, entry.content)));
    const entries: KnowledgeEntry[] = [];

    for (const chunk of chunks) {
      if (chunk.content.trim().length < this.minContentLength) continue;

      const prompt = buildDocumentPrompt(metadata, chunk.content, chunk.metadata.title as string | undefined);
      const raw = await this.llmProvider.complete(prompt);
      const parsed = extractJsonBlock(raw);
      const candidates = normalizeKnowledgeCandidates(parsed);

      for (const candidate of candidates) {
        const entry = await this.toKnowledgeEntry(candidate, source, chunk.content, chunk.metadata, metadata);
        if (!entry) continue;
        if (isDuplicateEntry(entry, existingEntries)) continue;

        const key = dedupeKey(entry.type, entry.content);
        if (dedupe.has(key)) continue;

        dedupe.add(key);
        entries.push(entry);
      }
    }

    return entries;
  }

  async extractFromMarkdownWithArtifact(
    markdown: string,
    metadata: DocumentMetadata,
    source: KnowledgeSource,
    existingEntries: KnowledgeEntry[] = [],
  ): Promise<DocumentExtractionResult> {
    const sections = this.parser.parse(markdown, source);
    const candidateEntities: CandidateEntity[] = [];

    if (!this.llmProvider) {
      const entries = this.dedupeEntries(await this.extract(sections, source), existingEntries);
      for (const entry of entries) {
        candidateEntities.push({
          name: entry.title,
          type: entry.type,
          confidence: entry.confidence,
          content: entry.content,
        });
      }
      const artifact = createAnalysisArtifact('document', source, {
        candidateEntities,
        metadata: { path: metadata.path, sectionCount: sections.length },
      });
      return { entries, artifact };
    }

    const chunks = this.chunkStrategy.chunkSectionsByTokenBudget(sections);
    const dedupe = new Set(existingEntries.map(entry => dedupeKey(entry.type, entry.content)));
    const entries: KnowledgeEntry[] = [];

    for (const chunk of chunks) {
      if (chunk.content.trim().length < this.minContentLength) continue;

      const prompt = buildDocumentPrompt(metadata, chunk.content, chunk.metadata.title as string | undefined);
      const raw = await this.llmProvider.complete(prompt);
      const parsed = extractJsonBlock(raw);
      const candidates = normalizeKnowledgeCandidates(parsed);

      for (const candidate of candidates) {
        const content = (candidate.content as string)?.trim();
        if (content) {
          const classification = await this.classifier.classify(content);
          candidateEntities.push({
            name: (candidate.title as string)?.trim() || generateTitle(content),
            type: isKnowledgeType(candidate.type as string) ? (candidate.type as KnowledgeType) : classification.type,
            confidence: clampConfidence(candidate.confidence as number, classification.confidence),
            content,
          });
        }

        const entry = await this.toKnowledgeEntry(candidate, source, chunk.content, chunk.metadata, metadata);
        if (!entry) continue;
        if (isDuplicateEntry(entry, existingEntries)) continue;

        const key = dedupeKey(entry.type, entry.content);
        if (dedupe.has(key)) continue;

        dedupe.add(key);
        entries.push(entry);
      }
    }

    const artifact = createAnalysisArtifact('document', source, {
      candidateEntities,
      metadata: { path: metadata.path, chunkCount: chunks.length },
    });

    return { entries, artifact };
  }

  /**
   * Resolve type: if classifier returns low confidence, use heuristics
   * based on section structure (e.g., methodology for step-like content).
   */
  private resolveType(classifiedType: KnowledgeType, section: ParsedSection): KnowledgeType {
    const metaType = section.metadata?.type as string | undefined;
    if (metaType && this.isValidType(metaType)) {
      return metaType as KnowledgeType;
    }

    if (classifiedType === 'fact' && this.looksLikeMethodology(section.content)) {
      return 'methodology';
    }

    return classifiedType;
  }

  private isValidType(type: string): boolean {
    return ['fact', 'methodology', 'decision', 'experience', 'intent', 'meta'].includes(type);
  }

  private looksLikeMethodology(content: string): boolean {
    const stepPatterns = /^(\d+[\.\)]\s|步骤|Step\s)/m;
    const listCount = (content.match(/^[-*]\s/gm) || []).length;
    return stepPatterns.test(content) || listCount >= 3;
  }

  private extractTags(section: ParsedSection): string[] {
    const metaTags = section.metadata?.tags;
    if (Array.isArray(metaTags)) {
      return metaTags.map(t => String(t));
    }
    return [];
  }

  private extractDomain(section: ParsedSection): string | undefined {
    const domain = section.metadata?.domain;
    return typeof domain === 'string' ? domain : undefined;
  }

  private generateTitle(content: string): string {
    return generateTitle(content);
  }

  private generateSummary(content: string): string {
    return generateSummary(content);
  }

  /**
   * FR-A02 AC1: Extract from any supported format.
   * Detects format from metadata/content, selects the right parser, and runs extraction.
   * Supports markdown, plain text, HTML, and pre-converted PDF/EPUB content.
   */
  async extractFromDocument(
    content: string,
    metadata: DocumentMetadata,
    source: KnowledgeSource,
    existingEntries: KnowledgeEntry[] = [],
    format: DocumentFormat = 'auto',
  ): Promise<KnowledgeEntry[]> {
    const resolvedFormat = format === 'auto' ? detectDocumentFormat(metadata, content) : format;
    const parser = parserForFormat(resolvedFormat);
    const sections = parser.parse(content, source);

    if (!this.llmProvider) {
      return this.dedupeEntries(await this.extract(sections, source), existingEntries);
    }

    // Delegate to the LLM-based path using the parsed sections
    const chunks = this.chunkStrategy.chunkSectionsByTokenBudget(sections);
    const dedupe = new Set(existingEntries.map(entry => dedupeKey(entry.type, entry.content)));
    const entries: KnowledgeEntry[] = [];

    for (const chunk of chunks) {
      if (chunk.content.trim().length < this.minContentLength) continue;

      const prompt = buildDocumentPrompt(metadata, chunk.content, chunk.metadata.title as string | undefined);
      const raw = await this.llmProvider.complete(prompt);
      const parsed = extractJsonBlock(raw);
      const candidates = normalizeKnowledgeCandidates(parsed);

      for (const candidate of candidates) {
        const entry = await this.toKnowledgeEntry(candidate, source, chunk.content, chunk.metadata, metadata);
        if (!entry) continue;
        if (isDuplicateEntry(entry, existingEntries)) continue;

        const key = dedupeKey(entry.type, entry.content);
        if (dedupe.has(key)) continue;

        dedupe.add(key);
        entries.push(entry);
      }
    }

    return entries;
  }

  /**
   * FR-A02 AC1+AC5: Extract from any format with Analysis Artifact.
   */
  async extractFromDocumentWithArtifact(
    content: string,
    metadata: DocumentMetadata,
    source: KnowledgeSource,
    existingEntries: KnowledgeEntry[] = [],
    format: DocumentFormat = 'auto',
  ): Promise<DocumentExtractionResult> {
    const resolvedFormat = format === 'auto' ? detectDocumentFormat(metadata, content) : format;
    const parser = parserForFormat(resolvedFormat);
    const sections = parser.parse(content, source);
    const candidateEntities: CandidateEntity[] = [];

    if (!this.llmProvider) {
      const entries = this.dedupeEntries(await this.extract(sections, source), existingEntries);
      for (const entry of entries) {
        candidateEntities.push({
          name: entry.title,
          type: entry.type,
          confidence: entry.confidence,
          content: entry.content,
        });
      }
      const artifact = createAnalysisArtifact('document', source, {
        candidateEntities,
        metadata: { path: metadata.path, sectionCount: sections.length, format: resolvedFormat },
      });
      return { entries, artifact };
    }

    const chunks = this.chunkStrategy.chunkSectionsByTokenBudget(sections);
    const dedupe = new Set(existingEntries.map(entry => dedupeKey(entry.type, entry.content)));
    const entries: KnowledgeEntry[] = [];

    for (const chunk of chunks) {
      if (chunk.content.trim().length < this.minContentLength) continue;

      const prompt = buildDocumentPrompt(metadata, chunk.content, chunk.metadata.title as string | undefined);
      const raw = await this.llmProvider.complete(prompt);
      const parsed = extractJsonBlock(raw);
      const candidates = normalizeKnowledgeCandidates(parsed);

      for (const candidate of candidates) {
        const content = (candidate.content as string)?.trim();
        if (content) {
          const classification = await this.classifier.classify(content);
          candidateEntities.push({
            name: (candidate.title as string)?.trim() || generateTitle(content),
            type: isKnowledgeType(candidate.type as string) ? (candidate.type as KnowledgeType) : classification.type,
            confidence: clampConfidence(candidate.confidence as number, classification.confidence),
            content,
          });
        }

        const entry = await this.toKnowledgeEntry(candidate, source, chunk.content, chunk.metadata, metadata);
        if (!entry) continue;
        if (isDuplicateEntry(entry, existingEntries)) continue;

        const key = dedupeKey(entry.type, entry.content);
        if (dedupe.has(key)) continue;

        dedupe.add(key);
        entries.push(entry);
      }
    }

    const artifact = createAnalysisArtifact('document', source, {
      candidateEntities,
      metadata: { path: metadata.path, chunkCount: chunks.length, format: resolvedFormat },
    });

    return { entries, artifact };
  }

  private dedupeEntries(entries: KnowledgeEntry[], existingEntries: KnowledgeEntry[]): KnowledgeEntry[] {
    const dedupe = new Set(existingEntries.map(entry => dedupeKey(entry.type, entry.content)));
    const results: KnowledgeEntry[] = [];

    for (const entry of entries) {
      const key = dedupeKey(entry.type, entry.content);
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      results.push(entry);
    }

    return results;
  }

  private async toKnowledgeEntry(
    candidate: CandidateInput,
    source: KnowledgeSource,
    chunkContent: string,
    chunkMetadata: Record<string, unknown>,
    metadata: DocumentMetadata,
  ): Promise<KnowledgeEntry | null> {
    const content = candidate.content?.trim();
    if (!content || content.length < this.minContentLength) return null;

    const classification = await this.classifier.classify(content);
    const type: KnowledgeType = isKnowledgeType(candidate.type) ? candidate.type : classification.type;
    const confidence = clampConfidence(candidate.confidence, classification.confidence);
    const now = new Date();
    const title = shortenKnowledgeTitle(
      candidate.title?.trim() || (typeof chunkMetadata.title === 'string' ? chunkMetadata.title : metadata.title),
      content,
    );
    const tags = uniqueTags([
      ...(Array.isArray(chunkMetadata.tags) ? chunkMetadata.tags.map(tag => String(tag)) : []),
      ...(candidate.tags ?? []),
    ]);
    const domain = typeof chunkMetadata.domain === 'string' ? chunkMetadata.domain : undefined;

    const sourceRange = normalizeSourceRange(
      chunkMetadata.sourceRange,
      metadata.path || source.reference,
      typeof chunkMetadata.title === 'string' ? chunkMetadata.title : metadata.title,
      chunkContent,
    );

    return {
      id: randomUUID(),
      type,
      title,
      content,
      summary: candidate.summary?.trim() || generateSummary(content),
      source: buildDerivedSource(source, `${metadata.path}\n${chunkContent}`),
      sourceRange,
      confidence,
      status: 'active',
      tags,
      domain,
      similarSentences: normalizeSimilarSentences(candidate),
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
  }
}

/**
 * Supported document formats for FR-A02 AC1.
 * 'auto' attempts to detect format from metadata or content.
 */
export type DocumentFormat = 'markdown' | 'plaintext' | 'html' | 'auto';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);
const PLAINTEXT_EXTENSIONS = new Set(['.txt', '.text', '.log', '.csv', '.tsv']);
const HTML_EXTENSIONS = new Set(['.html', '.htm']);

/**
 * Detect document format from file path extension or content heuristics.
 * PDF/EPUB are expected to be pre-converted to text before reaching the extractor.
 */
export function detectDocumentFormat(metadata: DocumentMetadata, content: string): DocumentFormat {
  const path = metadata.path.toLowerCase();
  const ext = path.slice(path.lastIndexOf('.'));

  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (PLAINTEXT_EXTENSIONS.has(ext)) return 'plaintext';
  if (HTML_EXTENSIONS.has(ext)) return 'html';

  // URL heuristic: web content is typically HTML-derived, treat as plaintext
  // (web page content is expected to be pre-extracted to readable text)
  if (path.startsWith('http://') || path.startsWith('https://')) return 'plaintext';

  // Content heuristic: check for markdown indicators
  if (/^#{1,6}\s/m.test(content) || /^---\s*\n/.test(content)) return 'markdown';
  if (/<\/?[a-z][\s\S]*>/i.test(content)) return 'html';

  return 'plaintext';
}

/** Select the appropriate parser for a given format. */
function parserForFormat(format: DocumentFormat): DocumentParser {
  switch (format) {
    case 'markdown': return new MarkdownParser();
    case 'html':
    case 'plaintext': return new PlainTextParser();
    default: return new MarkdownParser();
  }
}

export type { ParsedSection } from './document-parser.js';

function normalizeSourceRange(
  raw: unknown,
  fallbackDocumentId: string,
  fallbackSection: string | undefined,
  fallbackText: string,
): SourceRange {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const documentId = typeof value.documentId === 'string' && value.documentId.trim()
    ? value.documentId.trim()
    : fallbackDocumentId;
  const section = typeof value.section === 'string' && value.section.trim()
    ? value.section.trim()
    : fallbackSection;
  const page = typeof value.page === 'number' && Number.isFinite(value.page)
    ? Math.max(1, Math.floor(value.page))
    : undefined;
  const paragraph = normalizeParagraphRange(value.paragraph);
  const originalText = typeof value.originalText === 'string' && value.originalText.trim()
    ? value.originalText
    : fallbackText;

  return {
    documentId,
    ...(page !== undefined ? { page } : {}),
    ...(paragraph !== undefined ? { paragraph } : {}),
    ...(section ? { section } : {}),
    originalText,
  };
}

function normalizeParagraphRange(raw: unknown): SourceRange['paragraph'] | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const start = typeof value.start === 'number' && Number.isFinite(value.start)
    ? Math.max(1, Math.floor(value.start))
    : undefined;
  const end = typeof value.end === 'number' && Number.isFinite(value.end)
    ? Math.max(start ?? 1, Math.floor(value.end))
    : undefined;
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

function normalizeSimilarSentences(candidate: CandidateInput): string[] | undefined {
  const raw = Array.isArray(candidate.similar_sentences)
    ? candidate.similar_sentences
    : Array.isArray(candidate.similarSentences)
      ? candidate.similarSentences
      : [];
  const normalized = raw
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean)
    .slice(0, 3);
  return normalized.length > 0 ? normalized : undefined;
}

function buildDocumentPrompt(metadata: DocumentMetadata, chunkContent: string, sectionTitle?: string): string {
  return [
    '从文档片段中萃取可长期复用的知识。返回纯 JSON。',
    '知识定义：知识是经过抽象、聚合、萃取后的长效理解模型，必须跨时间、跨场景可复用，并能回答「它让 agent 在什么场景下避免什么错误」。',
    '禁止提取：任务派发指令、一次性调度安排、排查步骤记录、临时优先级决策、行为铁律/操作规则、具体文件路径、命令行、配置片段、未经抽象的事件记录。',
    '三重测试：1）三个月后还有价值；2）换项目/团队/场景仍适用；3）去掉具体人名、项目名、时间后仍是理解模型。任一不通过就丢弃。',
    '抽象归纳要求：title 不能照搬原文，必须由 LLM 归纳为 ≤30 字的跨场景短标题；content 不能照搬原文，必须说明场景、原则、原因。',
    'similar_sentences：每条知识必须生成 2-3 条泛化相似表述，用于后续语义检索匹配，不要复制原句。',
    'Schema: [{"type":"fact|methodology|decision|experience|intent|meta","title":"≤30字抽象短标题","content":"场景+原则+原因","summary":"一句话摘要","confidence":0.0,"tags":["string"],"similar_sentences":["泛化表述1","泛化表述2"]}]',
    '如果没有通过三重测试的知识，返回 []。',
    `Document path: ${metadata.path}`,
    metadata.title ? `Document title: ${metadata.title}` : undefined,
    sectionTitle ? `Section title: ${sectionTitle}` : undefined,
    'Chunk:',
    chunkContent,
  ].filter(Boolean).join('\n\n');
}
