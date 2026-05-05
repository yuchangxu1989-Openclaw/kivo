/**
 * PipelineEngine — Event-driven async extraction pipeline.
 *
 * Orchestrates the pipeline-filter flow (ADR-001):
 * intake → extraction → analysis_artifact → classification → conflict_detection → merge_detection → quality_gate → persistence → complete
 *
 * Async extraction does not block the caller (NFR-4.2).
 * Each stage emits events through EventBus for observability and loose coupling.
 */

import { randomUUID } from 'node:crypto';
import type {
  ExtractionTask,
  KnowledgeEntry,
  KnowledgeSource,
  PipelineEvent,
  PipelineStage,
} from '../types/index.js';
import { EventBus } from './event-bus.js';
import { Classifier } from './classifier.js';
import { Extractor, type ExtractorOptions } from './extractor.js';
import { evaluateQuality } from './quality-gate.js';
import type { ConflictDetector } from '../conflict/index.js';
import type { KnowledgeRepository } from '../repository/knowledge-repository.js';
import {
  AnalysisArtifactStore,
  type AnalysisArtifact,
  type AnalysisArtifactInput,
} from './analysis-artifact-store.js';

export interface PipelineContext {
  task: ExtractionTask;
  entries: KnowledgeEntry[];
  activeEntries: KnowledgeEntry[];
  artifact?: AnalysisArtifact;
  routeSummary?: Record<string, unknown>;
}

export interface RegisteredPipelineStage {
  name: PipelineStage;
  run: (context: PipelineContext) => Promise<Record<string, unknown> | void>;
  after?: PipelineStage;
}

export interface PipelineEngineOptions {
  extractor?: ExtractorOptions;
  classifier?: Classifier;
  conflictDetector?: ConflictDetector;
  repository?: KnowledgeRepository;
  confidenceThreshold?: number;
  analysisArtifactStore?: AnalysisArtifactStore;
  qualityGateEnabled?: boolean;
}

const BUILTIN_STAGE_ORDER: PipelineStage[] = [
  'extraction',
  'analysis_artifact',
  'classification',
  'conflict_detection',
  'merge_detection',
  'quality_gate',
  'persistence',
];

export class PipelineEngine {
  readonly bus: EventBus;
  private extractor: Extractor;
  private classifier: Classifier;
  private conflictDetector?: ConflictDetector;
  private repository?: KnowledgeRepository;
  private confidenceThreshold: number;
  private artifactStore?: AnalysisArtifactStore;
  private qualityGateEnabled: boolean;
  private tasks: Map<string, ExtractionTask> = new Map();
  private readonly customStages: RegisteredPipelineStage[] = [];

  constructor(options: PipelineEngineOptions = {}) {
    this.bus = new EventBus();
    this.classifier = options.classifier ?? options.extractor?.classifier ?? new Classifier();
    this.extractor = new Extractor({
      ...options.extractor,
      classifier: options.classifier ?? options.extractor?.classifier ?? this.classifier,
    });
    this.conflictDetector = options.conflictDetector;
    this.repository = options.repository;
    this.confidenceThreshold = options.confidenceThreshold ?? 0.7;
    this.artifactStore = options.analysisArtifactStore;
    this.qualityGateEnabled = options.qualityGateEnabled ?? true;
  }

  /**
   * Submit raw text for async extraction.
   * Returns immediately with task id — extraction runs in background.
   */
  submit(input: string, source: KnowledgeSource): string {
    const task: ExtractionTask = {
      id: randomUUID(),
      status: 'pending',
      input,
      source,
      results: [],
      createdAt: new Date(),
    };

    this.tasks.set(task.id, task);
    this.emitEvent('task:created', task.id, 'intake', { inputLength: input.length });

    void this.runPipeline(task).catch((err) => {
      this.failTask(task, 'intake', err, { inputLength: input.length });
    });

    return task.id;
  }

  /** Get task by id */
  getTask(taskId: string): ExtractionTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Get all extracted entries from a completed task */
  getResults(taskId: string): KnowledgeEntry[] {
    return this.tasks.get(taskId)?.results ?? [];
  }

  /** Register a custom stage without modifying existing stage logic */
  registerStage(stage: RegisteredPipelineStage): void {
    this.customStages.push(stage);
  }

  private async runPipeline(task: ExtractionTask): Promise<void> {
    task.status = 'running';
    this.emitEvent('task:started', task.id, 'intake', {});

    const context: PipelineContext = {
      task,
      entries: [],
      activeEntries: [],
    };

    await this.runExtractionStage(context);
    await this.runAnalysisArtifactStage(context);
    await this.runClassificationStage(context);
    await this.runConflictStage(context);
    await this.runMergeDetectionStage(context);
    await this.runQualityGateStage(context);
    await this.runPersistenceStage(context);

    const executedBuiltin = new Set(BUILTIN_STAGE_ORDER);
    for (const stage of this.customStages) {
      if (executedBuiltin.has(stage.name)) continue;
      await this.runCustomStage(stage, context);
    }

    task.status = 'completed';
    task.completedAt = new Date();
    this.emitEvent('task:completed', task.id, 'complete', {
      totalEntries: context.entries.length,
      artifactId: task.artifactId,
      duration: task.completedAt.getTime() - task.createdAt.getTime(),
    });
  }

  private async runExtractionStage(context: PipelineContext): Promise<void> {
    const { task } = context;
    this.enterStage(task.id, 'extraction');
    try {
      const entries = await this.extractor.extract(task.input, task.source);
      context.entries = entries;
      task.results = entries;
      this.completeStage(task.id, 'extraction', { entryCount: entries.length });
      await this.runCustomStagesAfter('extraction', context);
    } catch (error) {
      this.failTask(task, 'extraction', error, { inputLength: task.input.length });
      throw error;
    }
  }

  private async runAnalysisArtifactStage(context: PipelineContext): Promise<void> {
    const { task, entries } = context;
    if (!this.artifactStore) {
      this.skipStage(task.id, 'analysis_artifact', { reason: 'No analysisArtifactStore injected' });
      await this.runCustomStagesAfter('analysis_artifact', context);
      return;
    }

    this.enterStage(task.id, 'analysis_artifact');
    try {
      const artifact = await this.artifactStore.saveArtifact(this.buildArtifactInput(task, entries));
      context.artifact = artifact;
      task.artifactId = artifact.id;
      this.completeStage(task.id, 'analysis_artifact', {
        artifactId: artifact.id,
        reviewCandidates: artifact.reviewCandidates.length,
        status: artifact.status,
      });
      await this.runCustomStagesAfter('analysis_artifact', context);
    } catch (error) {
      this.failTask(task, 'analysis_artifact', error, { entryCount: entries.length });
      throw error;
    }
  }

  private async runClassificationStage(context: PipelineContext): Promise<void> {
    const { task, entries } = context;
    if (entries.length === 0) {
      this.skipStage(task.id, 'classification', { reason: 'No extracted entries' });
      await this.runCustomStagesAfter('classification', context);
      return;
    }

    this.enterStage(task.id, 'classification');
    try {
      const routeSummary: Record<string, number> = {};

      for (const entry of entries) {
        const classification = await this.classifier.classify(`${entry.title}\n${entry.content}`);
        entry.type = classification.type;
        entry.domain = entry.domain ?? classification.domain;
        entry.confidence = classification.confidence;
        if (classification.confidence < this.confidenceThreshold) {
          entry.status = 'pending';
        } else if (entry.status !== 'rejected') {
          entry.status = 'active';
        }

        const route = this.routeForEntry(entry);
        routeSummary[route] = (routeSummary[route] ?? 0) + 1;

        this.emitEvent('entry:extracted', task.id, 'classification', {
          entryId: entry.id,
          type: entry.type,
          domain: entry.domain,
          confidence: entry.confidence,
          route,
          status: entry.status,
        });
      }

      context.activeEntries = entries.filter((entry) => entry.status !== 'pending');
      context.routeSummary = routeSummary;

      this.completeStage(task.id, 'classification', {
        classified: entries.length,
        pending: entries.length - context.activeEntries.length,
        routes: routeSummary,
      });
      await this.runCustomStagesAfter('classification', context);
    } catch (error) {
      this.failTask(task, 'classification', error, { entryCount: entries.length });
      throw error;
    }
  }

  private async runConflictStage(context: PipelineContext): Promise<void> {
    const { task, activeEntries } = context;
    if (activeEntries.length === 0) {
      this.skipStage(task.id, 'conflict_detection', {
        reason: 'No active entries after classification threshold',
      });
      await this.runCustomStagesAfter('conflict_detection', context);
      return;
    }

    this.enterStage(task.id, 'conflict_detection');
    try {
      let conflictCount = 0;
      if (this.conflictDetector) {
        for (const entry of activeEntries) {
          const others = activeEntries.filter((candidate) => candidate.id !== entry.id);
          const conflicts = await this.conflictDetector.detect(entry, others);
          conflictCount += conflicts.length;
          for (const conflict of conflicts) {
            this.emitEvent('conflict:detected', task.id, 'conflict_detection', {
              incomingId: conflict.incomingId,
              existingId: conflict.existingId,
            });
          }
        }
      }

      this.completeStage(task.id, 'conflict_detection', { conflicts: conflictCount });
      await this.runCustomStagesAfter('conflict_detection', context);
    } catch (error) {
      this.failTask(task, 'conflict_detection', error, { activeEntryCount: activeEntries.length });
      throw error;
    }
  }

  private async runMergeDetectionStage(context: PipelineContext): Promise<void> {
    const { task, activeEntries } = context;
    if (activeEntries.length === 0) {
      this.skipStage(task.id, 'merge_detection', {
        reason: 'No active entries after classification threshold',
      });
      await this.runCustomStagesAfter('merge_detection', context);
      return;
    }

    this.enterStage(task.id, 'merge_detection');
    try {
      const seen = new Set<string>();
      let mergeCandidates = 0;

      for (const entry of activeEntries) {
        const key = `${entry.type}:${normalizeText(entry.title)}:${normalizeText(entry.content)}`;
        if (seen.has(key)) {
          mergeCandidates += 1;
        } else {
          seen.add(key);
        }
      }

      this.completeStage(task.id, 'merge_detection', { mergeCandidates });
      await this.runCustomStagesAfter('merge_detection', context);
    } catch (error) {
      this.failTask(task, 'merge_detection', error, { activeEntryCount: activeEntries.length });
      throw error;
    }
  }

  private async runQualityGateStage(context: PipelineContext): Promise<void> {
    const { task } = context;
    if (!this.qualityGateEnabled) {
      this.skipStage(task.id, 'quality_gate', { reason: 'Quality gate disabled' });
      await this.runCustomStagesAfter('quality_gate', context);
      return;
    }

    if (context.activeEntries.length === 0) {
      this.skipStage(task.id, 'quality_gate', {
        reason: 'No active entries after classification threshold',
      });
      await this.runCustomStagesAfter('quality_gate', context);
      return;
    }

    this.enterStage(task.id, 'quality_gate');
    try {
      const evaluatedCount = context.activeEntries.length;
      const passedEntries: KnowledgeEntry[] = [];
      const rejectedEntries: Array<{ entryId: string; reason: string }> = [];

      for (const entry of context.activeEntries) {
        const result = evaluateQuality(entry);
        if (result.passed) {
          passedEntries.push(entry);
          continue;
        }

        entry.status = 'rejected';
        rejectedEntries.push({
          entryId: entry.id,
          reason: result.reason ?? 'unknown',
        });
      }

      context.activeEntries = passedEntries;

      if (rejectedEntries.length > 0) {
        this.emitEvent('pipeline:warning', task.id, 'quality_gate', {
          message: 'Filtered low-value entries before persistence',
          rejectedEntries,
        });
      }

      this.completeStage(task.id, 'quality_gate', {
        evaluated: evaluatedCount,
        passed: passedEntries.length,
        rejected: rejectedEntries.length,
      });
      await this.runCustomStagesAfter('quality_gate', context);
    } catch (error) {
      this.failTask(task, 'quality_gate', error, { activeEntryCount: context.activeEntries.length });
      throw error;
    }
  }

  private async runPersistenceStage(context: PipelineContext): Promise<void> {
    const { task, entries, activeEntries } = context;
    if (activeEntries.length === 0) {
      this.skipStage(task.id, 'persistence', {
        reason: 'No active entries eligible for persistence',
        pending: entries.filter((entry) => entry.status === 'pending').length,
        rejected: entries.filter((entry) => entry.status === 'rejected').length,
      });
      await this.runCustomStagesAfter('persistence', context);
      return;
    }

    this.enterStage(task.id, 'persistence');
    try {
      let persistedCount = 0;
      const pendingCount = entries.filter((entry) => entry.status === 'pending').length;
      const rejectedCount = entries.filter((entry) => entry.status === 'rejected').length;

      if (this.repository) {
        for (const entry of activeEntries) {
          if (entry.confidence >= this.confidenceThreshold) {
            const saved = await this.repository.save(entry);
            if (saved !== false) {
              persistedCount += 1;
            } else {
              entry.status = 'rejected';
            }
          } else {
            entry.status = 'pending';
          }
        }
      } else {
        this.emitEvent('pipeline:warning', task.id, 'persistence', {
          message: 'No repository injected — entries kept in-memory only',
        });
      }

      this.completeStage(task.id, 'persistence', {
        persisted: persistedCount,
        pending: pendingCount,
        rejected: rejectedCount,
      });
      await this.runCustomStagesAfter('persistence', context);
    } catch (error) {
      this.failTask(task, 'persistence', error, { activeEntryCount: activeEntries.length });
      throw error;
    }
  }

  private async runCustomStagesAfter(after: PipelineStage, context: PipelineContext): Promise<void> {
    const stages = this.customStages.filter((stage) => stage.after === after);
    for (const stage of stages) {
      await this.runCustomStage(stage, context);
    }
  }

  private async runCustomStage(stage: RegisteredPipelineStage, context: PipelineContext): Promise<void> {
    const { task } = context;
    this.enterStage(task.id, stage.name);
    try {
      const payload = await stage.run(context);
      this.completeStage(task.id, stage.name, payload ?? {});
    } catch (error) {
      this.failTask(task, stage.name, error, { customStage: stage.name });
      throw error;
    }
  }

  private buildArtifactInput(task: ExtractionTask, entries: KnowledgeEntry[]): AnalysisArtifactInput {
    return {
      sourceId: task.source.reference,
      pipelineId: task.id,
      extractedClaims: entries.map((entry) => ({
        id: entry.id,
        text: entry.summary || entry.content,
        confidence: entry.confidence,
        type: entry.type,
      })),
      entityCandidates: entries.map((entry) => ({
        id: entry.id,
        label: entry.title,
        confidence: entry.confidence,
        payload: { type: entry.type, domain: entry.domain },
      })),
      conceptCandidates: entries.map((entry) => ({
        id: `${entry.id}:concept`,
        label: entry.type,
        confidence: entry.confidence,
        payload: { domain: entry.domain },
      })),
      linkCandidates: [],
      conflictCandidates: [],
      gapCandidates: entries
        .filter((entry) => /\?|？/.test(entry.content) || /需要|待确认|unknown|todo/i.test(entry.content))
        .map((entry) => ({
          id: `${entry.id}:gap`,
          label: entry.title,
          confidence: 1 - entry.confidence,
          payload: { reason: 'content_gap_signal' },
        })),
      reviewCandidates: entries
        .filter((entry) => entry.status === 'pending' || entry.confidence < this.confidenceThreshold)
        .map((entry) => ({
          id: `${entry.id}:review`,
          field: 'extractedClaims',
          candidateId: entry.id,
          reason: 'low_confidence',
          confidence: entry.confidence,
        })),
      recommendedResearchQueries: entries
        .filter((entry) => /\?|？/.test(entry.content))
        .map((entry) => `${entry.title} 需要补充什么事实依据？`),
      confidence: entries.length > 0
        ? entries.reduce((sum, entry) => sum + entry.confidence, 0) / entries.length
        : 1,
    };
  }

  private routeForEntry(entry: KnowledgeEntry): string {
    switch (entry.type) {
      case 'intent':
      case 'decision':
        return 'strict_conflict_check';
      case 'methodology':
        return 'methodology_normalization';
      case 'experience':
        return 'experience_review';
      case 'meta':
        return 'meta_governance';
      case 'fact':
      default:
        return 'default_persistence';
    }
  }

  private failTask(
    task: ExtractionTask,
    stage: PipelineStage,
    error: unknown,
    failureContext: Record<string, unknown>,
  ): void {
    task.status = 'failed';
    task.failedStage = stage;
    task.error = error instanceof Error ? error.message : String(error);
    task.failureContext = failureContext;
    this.emitEvent('task:failed', task.id, stage, {
      error: task.error,
      failedStage: stage,
      ...failureContext,
    });
  }

  private enterStage(taskId: string, stage: PipelineStage): void {
    this.emitEvent('stage:entered', taskId, stage, {});
  }

  private completeStage(taskId: string, stage: PipelineStage, payload: Record<string, unknown>): void {
    this.emitEvent('stage:completed', taskId, stage, payload);
  }

  private skipStage(taskId: string, stage: PipelineStage, payload: Record<string, unknown>): void {
    this.emitEvent('stage:skipped', taskId, stage, payload);
  }

  private emitEvent(
    type: PipelineEvent['type'],
    taskId: string,
    stage: PipelineStage,
    payload: Record<string, unknown>,
  ): void {
    this.bus.emit({ type, taskId, stage, timestamp: new Date(), payload });
  }

  /** Cleanup: remove all listeners */
  destroy(): void {
    this.bus.removeAllListeners();
    this.tasks.clear();
  }
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
