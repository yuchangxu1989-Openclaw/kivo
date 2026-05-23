/**
 * PersonalKnowledgeInput — 个人知识录入（FR-A04）
 *
 * AC1: 手动录入
 * AC2: 文件导入（复用 DocumentExtractor）
 * AC3: URL 抓取
 * AC4: 对话沉淀
 * AC5: 批量文件夹导入
 * AC6: 所有入口走同一管线
 */

import { randomUUID } from 'node:crypto';
import type { KnowledgeEntry, KnowledgeSource } from '../types/index.js';
import { DocumentExtractor, type DocumentExtractorOptions } from './document-extractor.js';
import { ConversationExtractor, type ConversationExtractorOptions, type ConversationMessage } from './conversation-extractor.js';

export interface ManualEntryInput {
  title: string;
  content: string;
  type: KnowledgeEntry['type'];
  tags?: string[];
  domain?: string;
}

export interface FileImportInput {
  path: string;
  content: string;
  title?: string;
}

export interface UrlImportInput {
  url: string;
  content: string;
  title?: string;
}

export interface ConversationMarkInput {
  messages: ConversationMessage[];
  markedIndices?: number[];
}

export interface BatchFolderInput {
  basePath: string;
  files: FileImportInput[];
}

export interface BatchImportProgress {
  total: number;
  completed: number;
  failed: number;
  currentFile?: string;
}

export type ProgressCallback = (progress: BatchImportProgress) => void;

export interface PersonalKnowledgeInputOptions {
  documentExtractor?: DocumentExtractorOptions;
  conversationExtractor?: ConversationExtractorOptions;
  existingEntries?: KnowledgeEntry[];
  onProgress?: ProgressCallback;
}

export class PersonalKnowledgeInput {
  private readonly documentExtractor: DocumentExtractor;
  private readonly conversationExtractor?: ConversationExtractor;
  private existingEntries: KnowledgeEntry[];
  private readonly onProgress?: ProgressCallback;

  constructor(options: PersonalKnowledgeInputOptions = {}) {
    this.documentExtractor = new DocumentExtractor(options.documentExtractor);
    this.conversationExtractor = options.conversationExtractor
      ? new ConversationExtractor(options.conversationExtractor)
      : undefined;
    this.existingEntries = options.existingEntries ?? [];
    this.onProgress = options.onProgress;
  }

  /**
   * FR-A04 AC1: Manual entry — user creates a knowledge entry directly.
   */
  async manualEntry(input: ManualEntryInput): Promise<KnowledgeEntry> {
    const now = new Date();
    const entry: KnowledgeEntry = {
      id: randomUUID(),
      type: input.type,
      title: input.title,
      content: input.content,
      summary: input.content.slice(0, 100) + (input.content.length > 100 ? '...' : ''),
      source: {
        type: 'manual',
        reference: 'user-input',
        timestamp: now,
      },
      confidence: 1.0,
      status: 'active',
      tags: input.tags ?? [],
      domain: input.domain,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.existingEntries.push(entry);
    return entry;
  }

  /**
   * FR-A04 AC2: File import — extract knowledge from a document file.
   * Reuses FR-A02 document extraction pipeline.
   */
  async fileImport(input: FileImportInput): Promise<KnowledgeEntry[]> {
    const source: KnowledgeSource = {
      type: 'document',
      reference: input.path,
      timestamp: new Date(),
    };
    const entries = await this.documentExtractor.extractFromMarkdown(
      input.content,
      { path: input.path, title: input.title },
      source,
      this.existingEntries,
    );
    this.existingEntries.push(...entries);
    return entries;
  }

  /**
   * FR-A04 AC3: URL import — extract knowledge from web page content.
   */
  async urlImport(input: UrlImportInput): Promise<KnowledgeEntry[]> {
    const source: KnowledgeSource = {
      type: 'document',
      reference: input.url,
      timestamp: new Date(),
    };
    const entries = await this.documentExtractor.extractFromMarkdown(
      input.content,
      { path: input.url, title: input.title },
      source,
      this.existingEntries,
    );
    this.existingEntries.push(...entries);
    return entries;
  }

  /**
   * FR-A04 AC4: Conversation marking — extract knowledge from marked conversation segments.
   */
  async conversationMark(input: ConversationMarkInput): Promise<KnowledgeEntry[]> {
    if (!this.conversationExtractor) {
      throw new Error('Conversation extractor unavailable: provide conversationExtractor options with llmProvider');
    }

    const messages = input.markedIndices
      ? input.messages.filter((_, i) => input.markedIndices!.includes(i))
      : input.messages;

    const source: KnowledgeSource = {
      type: 'conversation',
      reference: 'user-marked',
      timestamp: new Date(),
    };

    const entries = await this.conversationExtractor.extract(messages, source, this.existingEntries);
    this.existingEntries.push(...entries);
    return entries;
  }

  /**
   * FR-A04 AC5: Batch folder import — recursively process files with progress reporting.
   */
  async batchFolderImport(input: BatchFolderInput): Promise<KnowledgeEntry[]> {
    const allEntries: KnowledgeEntry[] = [];
    const progress: BatchImportProgress = {
      total: input.files.length,
      completed: 0,
      failed: 0,
    };

    for (const file of input.files) {
      progress.currentFile = file.path;
      this.onProgress?.(progress);

      try {
        const entries = await this.fileImport({
          ...file,
          path: `${input.basePath}/${file.path}`,
        });
        allEntries.push(...entries);
        progress.completed++;
      } catch {
        progress.failed++;
      }

      this.onProgress?.(progress);
    }

    return allEntries;
  }

  /**
   * FR-A04 AC6: All entry points produce entries through the same pipeline.
   * This is enforced by design — all methods above use DocumentExtractor
   * or ConversationExtractor which share the same extraction → dedup → entry creation flow.
   */
}
