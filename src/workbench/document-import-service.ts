/**
 * DocumentImportService — FR-W08 文档导入数据层
 *
 * AC1: 支持 PDF/Markdown/纯文本/EPUB，单文件上限 50MB
 * AC2: 提取进度（已处理分段/总分段）
 * AC3: 提取结果分类展示 + 逐条/批量确认
 * AC4: 来源段落定位
 * AC5: 导入摘要
 */

import { EventEmitter } from 'node:events';
import type { KnowledgeType } from '../types/index.js';
import type {
  ImportFileFormat,
  ImportProgress,
  ExtractedCandidate,
  ImportSummary,
  ReviewDecision,
  MAX_IMPORT_FILE_SIZE_BYTES,
} from './workbench-types.js';

// ── AC2: Progress event types ──

export type ImportEventType =
  | 'progress'
  | 'candidate-extracted'
  | 'status-changed'
  | 'completed'
  | 'failed';

export interface ImportEvent {
  type: ImportEventType;
  taskId: string;
  timestamp: Date;
  payload: Record<string, unknown>;
}

export type ImportEventHandler = (event: ImportEvent) => void;

// ── AC4: Source location index ──

export interface SourceLocation {
  candidateId: string;
  fileName: string;
  /** Page number (1-based) for PDF/EPUB, or line range for text/markdown */
  pageOrLine: string;
  /** Character offset range in the original document */
  charRange: [start: number, end: number];
  /** Raw excerpt from the source document around the extraction point */
  contextSnippet: string;
}

export interface ImportTask {
  id: string;
  fileName: string;
  format: ImportFileFormat;
  fileSizeBytes: number;
  progress: ImportProgress;
  candidates: ExtractedCandidate[];
  sourceLocations: Map<string, SourceLocation>;
  summary?: ImportSummary;
}

export class DocumentImportService {
  private tasks = new Map<string, ImportTask>();
  private idCounter = 0;
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(20);
  }

  /** AC2: Subscribe to import progress events */
  on(handler: ImportEventHandler): void {
    this.emitter.on('import', handler);
  }

  /** Unsubscribe from import events */
  off(handler: ImportEventHandler): void {
    this.emitter.off('import', handler);
  }

  private emit(type: ImportEventType, taskId: string, payload: Record<string, unknown> = {}): void {
    const event: ImportEvent = { type, taskId, timestamp: new Date(), payload };
    this.emitter.emit('import', event);
  }

  /** AC1: 验证文件格式和大小 */
  validateFile(fileName: string, sizeBytes: number): { valid: boolean; error?: string } {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const formatMap: Record<string, ImportFileFormat> = {
      pdf: 'pdf',
      md: 'markdown',
      markdown: 'markdown',
      txt: 'plaintext',
      epub: 'epub',
    };
    const format = ext ? formatMap[ext] : undefined;
    if (!format) {
      return { valid: false, error: `Unsupported format: ${ext}. Supported: pdf, md, txt, epub` };
    }
    const MAX_SIZE = 50 * 1024 * 1024;
    if (sizeBytes > MAX_SIZE) {
      return { valid: false, error: `File size ${sizeBytes} exceeds 50MB limit` };
    }
    return { valid: true };
  }

  /** 创建导入任务 */
  createTask(fileName: string, format: ImportFileFormat, sizeBytes: number): ImportTask {
    const id = `import-${++this.idCounter}`;
    const task: ImportTask = {
      id,
      fileName,
      format,
      fileSizeBytes: sizeBytes,
      progress: { taskId: id, processedSegments: 0, totalSegments: 0, status: 'uploading' },
      candidates: [],
      sourceLocations: new Map(),
    };
    this.tasks.set(id, task);
    this.emit('status-changed', id, { status: 'uploading' });
    return task;
  }

  /** AC2: 更新提取进度 (with event emission) */
  updateProgress(taskId: string, processed: number, total: number): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const prevStatus = task.progress.status;
    task.progress.processedSegments = processed;
    task.progress.totalSegments = total;
    task.progress.status = processed >= total ? 'reviewing' : 'extracting';
    this.emit('progress', taskId, {
      processedSegments: processed,
      totalSegments: total,
      percentComplete: total > 0 ? Math.round((processed / total) * 100) : 0,
    });
    if (task.progress.status !== prevStatus) {
      this.emit('status-changed', taskId, { status: task.progress.status });
    }
  }

  /** AC3 + AC4: 添加提取候选 (with source location tracking) */
  addCandidates(
    taskId: string,
    candidates: ExtractedCandidate[],
    sourceLocations?: SourceLocation[],
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.candidates.push(...candidates);

    // AC4: Index source locations for each candidate
    if (sourceLocations) {
      for (const loc of sourceLocations) {
        task.sourceLocations.set(loc.candidateId, loc);
      }
    }

    for (const c of candidates) {
      this.emit('candidate-extracted', taskId, {
        candidateId: c.id,
        type: c.type,
        title: c.title,
        sourceLocation: c.sourceLocation,
      });
    }
  }

  /** AC4: Get source location for a specific candidate */
  getSourceLocation(taskId: string, candidateId: string): SourceLocation | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return task.sourceLocations.get(candidateId);
  }

  /** AC4: Get all source locations for a task */
  getSourceLocations(taskId: string): SourceLocation[] {
    const task = this.tasks.get(taskId);
    if (!task) return [];
    return Array.from(task.sourceLocations.values());
  }

  /** AC3: 批量审核决策 */
  reviewCandidates(taskId: string, decisions: ReviewDecision[]): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    for (const decision of decisions) {
      const candidate = task.candidates.find((c) => c.id === decision.candidateId);
      if (!candidate) continue;
      switch (decision.action) {
        case 'accept':
          candidate.accepted = true;
          break;
        case 'reject':
          candidate.accepted = false;
          break;
        case 'edit':
          candidate.accepted = true;
          candidate.edited = true;
          if (decision.editedContent) candidate.content = decision.editedContent;
          break;
      }
    }
  }

  /** AC3: 全选批量确认 */
  acceptAll(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    for (const c of task.candidates) {
      c.accepted = true;
    }
  }

  /** AC5: 生成导入摘要 */
  finalize(taskId: string): ImportSummary | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const summary: ImportSummary = {
      taskId,
      fileName: task.fileName,
      totalExtracted: task.candidates.length,
      accepted: task.candidates.filter((c) => c.accepted === true && !c.edited).length,
      rejected: task.candidates.filter((c) => c.accepted === false).length,
      edited: task.candidates.filter((c) => c.edited === true).length,
      importedAt: new Date(),
    };
    task.summary = summary;
    task.progress.status = 'completed';
    this.emit('completed', taskId, {
      totalExtracted: summary.totalExtracted,
      accepted: summary.accepted,
      rejected: summary.rejected,
      edited: summary.edited,
    });
    return summary;
  }

  getTask(taskId: string): ImportTask | undefined {
    return this.tasks.get(taskId);
  }
}
