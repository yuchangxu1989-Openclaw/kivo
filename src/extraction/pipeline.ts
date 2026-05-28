/**
 * Extraction Pipeline (FR-K01) — Unified orchestrator entry.
 *
 * Conversation and document extraction are registered as stage chains on
 * PipelineOrchestrator. The public legacy methods remain for compatibility,
 * but they now execute through the shared orchestrator path.
 */

import type { KnowledgeEntry, KnowledgeSource, PipelineStage, PipelineEvent } from '../types/index.js';
import { ConversationExtractor, type ConversationExtractorOptions, type ConversationMessage } from './conversation-extractor.js';
import { DocumentExtractor, type DocumentExtractorOptions, type DocumentMetadata } from './document-extractor.js';
import { RuleExtractor, type RuleEntry, type RuleExtractorOptions } from './rule-extractor.js';
import { ChunkStrategy, type ChunkOptions, type Chunk } from './chunk-strategy.js';
import type { DetectedSignal } from '../intent-signal/signal-types.js';
import { SignalDetector, type SignalDetectorOptions } from '../intent-signal/signal-detector.js';
import { isDuplicateEntry } from './extraction-utils.js';
import { PipelineOrchestrator, type OrchestratorTask, type PipelineStageHandler } from '../pipeline/pipeline-orchestrator.js';

export interface ConversationPipelineInput {
  messages: ConversationMessage[];
  source: KnowledgeSource;
  existingEntries?: KnowledgeEntry[];
}

export interface DocumentPipelineInput {
  markdown: string;
  metadata: DocumentMetadata;
  source: KnowledgeSource;
  existingEntries?: KnowledgeEntry[];
}

export interface SignalDetectionOutput {
  signals: DetectedSignal[];
  messages: ConversationMessage[];
}

export interface DocumentParseOutput {
  chunks: Chunk[];
  metadata: DocumentMetadata;
}

export interface ExtractionOutput {
  entries: KnowledgeEntry[];
  source: KnowledgeSource;
}

export interface DeduplicationOutput {
  entries: KnowledgeEntry[];
  duplicatesRemoved: number;
}

export interface QualityAuditOutput {
  approved: KnowledgeEntry[];
  rejected: KnowledgeEntry[];
}

export interface PersistenceOutput {
  persisted: KnowledgeEntry[];
  errors: Array<{ entryId: string; error: string }>;
}

export interface StageResult<T> {
  stage: PipelineStage;
  success: boolean;
  output?: T;
  error?: string;
  durationMs: number;
}

export interface PipelineResult {
  pipelineType: 'conversation' | 'document';
  stages: StageResult<unknown>[];
  finalEntries: KnowledgeEntry[];
  signals?: DetectedSignal[];
  events: PipelineEvent[];
  orchestratorTaskId?: string;
  startedAt: Date;
  completedAt: Date;
  success: boolean;
}

export type ExtractionResultWithAudit = PipelineResult;
export type PipelineEventListener = (event: PipelineEvent) => void;

export interface ExtractionPipelineOptions {
  conversation?: ConversationExtractorOptions;
  document?: DocumentExtractorOptions;
  rule?: RuleExtractorOptions;
  chunk?: ChunkOptions;
  signalDetector?: SignalDetectorOptions;
  qualityAudit?: (entries: KnowledgeEntry[]) => Promise<{ approved: KnowledgeEntry[]; rejected: KnowledgeEntry[] }>;
  persist?: (entries: KnowledgeEntry[]) => Promise<PersistenceOutput>;
  onEvent?: PipelineEventListener;
}

export class ExtractionPipeline {
  private readonly conversationExtractor?: ConversationExtractor;
  private readonly documentExtractor: DocumentExtractor;
  private readonly ruleExtractor: RuleExtractor;
  private readonly chunkStrategy: ChunkStrategy;
  private readonly signalDetector?: SignalDetector;
  private readonly qualityAudit?: ExtractionPipelineOptions['qualityAudit'];
  private readonly persist?: ExtractionPipelineOptions['persist'];
  private readonly onEvent?: PipelineEventListener;
  private readonly conversationOrchestrator: PipelineOrchestrator;
  private readonly documentOrchestrator: PipelineOrchestrator;

  constructor(options: ExtractionPipelineOptions = {}) {
    this.conversationExtractor = options.conversation
      ? new ConversationExtractor(options.conversation)
      : undefined;
    this.documentExtractor = new DocumentExtractor(options.document);
    this.ruleExtractor = new RuleExtractor(options.rule);
    this.chunkStrategy = new ChunkStrategy(options.chunk ?? options.document?.chunkOptions);
    this.signalDetector = options.signalDetector
      ? new SignalDetector(options.signalDetector)
      : undefined;
    this.qualityAudit = options.qualityAudit;
    this.persist = options.persist;
    this.onEvent = options.onEvent;
    this.conversationOrchestrator = this.createConversationOrchestrator();
    this.documentOrchestrator = this.createDocumentOrchestrator();
  }

  getPipelineStatus(): {
    conversation: ReturnType<PipelineOrchestrator['getStatus']>;
    document: ReturnType<PipelineOrchestrator['getStatus']>;
  } {
    return {
      conversation: this.conversationOrchestrator.getStatus(),
      document: this.documentOrchestrator.getStatus(),
    };
  }

  async runConversationPipeline(input: ConversationPipelineInput): Promise<PipelineResult> {
    return this.runThroughOrchestrator('conversation', this.conversationOrchestrator, serializeConversationInput(input), input.source);
  }

  async runDocumentPipeline(input: DocumentPipelineInput): Promise<PipelineResult> {
    return this.runThroughOrchestrator('document', this.documentOrchestrator, serializeDocumentInput(input), input.source);
  }

  async extractFromConversation(
    messages: ConversationMessage[],
    source: KnowledgeSource,
    existingEntries: KnowledgeEntry[] = [],
  ): Promise<KnowledgeEntry[]> {
    const result = await this.runConversationPipeline({ messages, source, existingEntries });
    return result.finalEntries;
  }

  async extractFromDocument(
    markdown: string,
    metadata: DocumentMetadata,
    source: KnowledgeSource,
    existingEntries: KnowledgeEntry[] = [],
  ): Promise<KnowledgeEntry[]> {
    const result = await this.runDocumentPipeline({ markdown, metadata, source, existingEntries });
    return result.finalEntries;
  }

  async extractRules(text: string, source: KnowledgeSource): Promise<RuleEntry[]> {
    return this.ruleExtractor.extract(text, source);
  }

  async extractRuleKnowledge(text: string, source: KnowledgeSource): Promise<KnowledgeEntry[]> {
    const rules = await this.extractRules(text, source);
    return await this.ruleExtractor.toKnowledgeEntries(rules);
  }

  private createConversationOrchestrator(): PipelineOrchestrator {
    const orchestrator = new PipelineOrchestrator();
    this.forwardEvents(orchestrator);

    orchestrator.registerStage(this.stage('decontextualization', async (metadata, input) => {
      if (input.messages.length === 0) throw new Error('No messages provided');
      return {
        entries: [],
        metadata: {
          ...metadata,
          messages: input.messages,
          source: input.source,
          existingEntries: input.existingEntries ?? [],
        },
      };
    }));

    orchestrator.registerStage(this.stage('admission_gate', async (metadata) => ({
      entries: metadata.entries as KnowledgeEntry[],
      metadata: {
        signals: await this.detectSignals(metadata.messages as ConversationMessage[]),
      },
    })));

    orchestrator.registerStage(this.stage('cosine_dedup', async (metadata) => {
      const entries = await this.extractConversationEntries(metadata);
      return { entries, metadata: { entries } };
    }));

    orchestrator.registerStage(this.stage('material_staging', async (metadata) => ({
      entries: metadata.entries as KnowledgeEntry[],
      metadata: { stagedEntries: metadata.entries },
    })));

    orchestrator.registerStage(this.stage('abstract_aggregation', async (metadata) => {
      const audit = await this.auditEntries(metadata.entries as KnowledgeEntry[]);
      const approved = audit.approved;
      const rejected = audit.rejected;
      const persistResult = await this.persistEntries(approved);
      if (rejected.length > 0 && this.persist) await this.persist(rejected);
      return {
        entries: approved,
        metadata: { approved, rejected, persistResult },
      };
    }));

    return orchestrator;
  }

  private createDocumentOrchestrator(): PipelineOrchestrator {
    const orchestrator = new PipelineOrchestrator();
    this.forwardEvents(orchestrator);

    orchestrator.registerStage(this.stage('extraction', async (metadata, input) => {
      if (!input.markdown.trim()) throw new Error('Empty document content');
      const chunks = this.chunkStrategy.chunkByTokenBudget(input.markdown);
      const entries = await this.documentExtractor.extractFromMarkdown(
        input.markdown,
        input.metadata,
        input.source,
        input.existingEntries ?? [],
      );
      return {
        entries,
        metadata: {
          ...metadata,
          chunks,
          metadata: input.metadata,
          source: input.source,
          existingEntries: input.existingEntries ?? [],
        },
      };
    }));

    orchestrator.registerStage(this.stage('analysis_artifact', async (metadata) => ({
      entries: metadata.entries as KnowledgeEntry[],
      metadata: { analysisArtifact: { chunkCount: (metadata.chunks as Chunk[] | undefined)?.length ?? 0 } },
    })));

    orchestrator.registerStage(this.stage('classification', async (metadata) => ({
      entries: metadata.entries as KnowledgeEntry[],
      metadata: { classified: (metadata.entries as KnowledgeEntry[]).length },
    })));

    orchestrator.registerStage(this.stage('conflict_detection', async (metadata) => ({
      entries: metadata.entries as KnowledgeEntry[],
      metadata: { conflicts: [] },
    })));

    orchestrator.registerStage(this.stage('merge_detection', async (metadata) => {
      const existing = (metadata.existingEntries as KnowledgeEntry[] | undefined) ?? [];
      const unique: KnowledgeEntry[] = [];
      let duplicatesRemoved = 0;

      for (const entry of metadata.entries as KnowledgeEntry[]) {
        if (isDuplicateEntry(entry, existing) || isDuplicateEntry(entry, unique)) duplicatesRemoved++;
        else unique.push(entry);
      }

      return { entries: unique, metadata: { entries: unique, duplicatesRemoved } };
    }));

    orchestrator.registerStage(this.stage('persistence', async (metadata) => {
      const audit = await this.auditEntries(metadata.entries as KnowledgeEntry[]);
      const approved = audit.approved;
      const rejected = audit.rejected;
      const persistResult = await this.persistEntries(approved);
      if (rejected.length > 0 && this.persist) await this.persist(rejected);
      return { entries: approved, metadata: { approved, rejected, persistResult } };
    }));

    return orchestrator;
  }

  private stage(
    name: PipelineStage,
    execute: (metadata: Record<string, unknown>, input: any) => Promise<{ entries: KnowledgeEntry[]; metadata?: Record<string, unknown> }>,
  ): PipelineStageHandler {
    return {
      name,
      execute: async (context) => {
        const input = revivePipelineInput(JSON.parse(context.input));
        return execute({ ...context.metadata, entries: context.entries }, input);
      },
    };
  }

  private async runThroughOrchestrator(
    pipelineType: 'conversation' | 'document',
    orchestrator: PipelineOrchestrator,
    serializedInput: string,
    source: KnowledgeSource,
  ): Promise<PipelineResult> {
    const events: PipelineEvent[] = [];
    const listener = (event: PipelineEvent) => { events.push(event); };

    orchestrator.bus.onAny(listener);
    const startedAt = new Date();

    try {
      const task = await orchestrator.execute(serializedInput, source);
      return this.buildResultFromTask(pipelineType, task, events, startedAt);
    } finally {
      for (const type of PIPELINE_EVENT_TYPES) {
        orchestrator.bus.off(type, listener);
      }
    }
  }

  private buildResultFromTask(
    pipelineType: 'conversation' | 'document',
    task: OrchestratorTask,
    events: PipelineEvent[],
    startedAt: Date,
  ): PipelineResult {
    const stageResults: StageResult<unknown>[] = task.completedStages.map((stage) => ({
      stage,
      success: true,
      output: stage === task.completedStages[task.completedStages.length - 1] ? { entries: task.entries } : undefined,
      durationMs: 0,
    }));

    if (task.status === 'failed' && task.failedStage) {
      stageResults.push({ stage: task.failedStage, success: false, error: task.error, durationMs: 0 });
    }

    return {
      pipelineType,
      stages: stageResults,
      finalEntries: task.entries,
      signals: pipelineType === 'conversation' ? task.metadata.signals as DetectedSignal[] | undefined : undefined,
      events,
      orchestratorTaskId: task.id,
      startedAt,
      completedAt: task.completedAt ?? new Date(),
      success: task.status === 'completed',
    };
  }

  private forwardEvents(orchestrator: PipelineOrchestrator): void {
    if (!this.onEvent) return;
    orchestrator.bus.onAny((event) => this.onEvent?.(event));
  }

  private async detectSignals(messages: ConversationMessage[]): Promise<DetectedSignal[]> {
    if (!this.signalDetector) return [];
    return this.signalDetector.detectFromConversation(messages);
  }

  private async extractConversationEntries(metadata: Record<string, unknown>): Promise<KnowledgeEntry[]> {
    if (!this.conversationExtractor) throw new Error('Conversation extractor unavailable: provide conversation.llmProvider');
    return this.conversationExtractor.extract(
      metadata.messages as ConversationMessage[],
      metadata.source as KnowledgeSource,
      metadata.existingEntries as KnowledgeEntry[] | undefined ?? [],
    );
  }

  private async auditEntries(entries: KnowledgeEntry[]): Promise<QualityAuditOutput> {
    if (entries.length === 0) return { approved: [], rejected: [] };
    if (this.qualityAudit) return this.qualityAudit(entries);
    return { approved: entries, rejected: [] };
  }

  private async persistEntries(entries: KnowledgeEntry[]): Promise<PersistenceOutput> {
    if (!this.persist || entries.length === 0) return { persisted: entries, errors: [] };
    return this.persist(entries);
  }
}

const PIPELINE_EVENT_TYPES: PipelineEvent['type'][] = [
  'task:created', 'task:started', 'stage:entered', 'stage:completed', 'stage:skipped',
  'entry:extracted', 'conflict:detected', 'conflict:resolved',
  'task:completed', 'task:failed', 'pipeline:error', 'pipeline:warning',
];

function serializeConversationInput(input: ConversationPipelineInput): string {
  return JSON.stringify({
    ...input,
    source: serializeSource(input.source),
    existingEntries: serializeEntries(input.existingEntries ?? []),
  });
}

function serializeDocumentInput(input: DocumentPipelineInput): string {
  return JSON.stringify({
    ...input,
    source: serializeSource(input.source),
    existingEntries: serializeEntries(input.existingEntries ?? []),
  });
}

function revivePipelineInput<T extends ConversationPipelineInput | DocumentPipelineInput>(input: T): T {
  return {
    ...input,
    source: reviveSource(input.source),
    existingEntries: reviveEntries(input.existingEntries ?? []),
  } as T;
}

function reviveSource(source: KnowledgeSource): KnowledgeSource {
  return { ...source, timestamp: new Date(source.timestamp) };
}

function reviveEntries(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  return entries.map((entry) => ({
    ...entry,
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
    source: reviveSource(entry.source),
  }));
}

function serializeSource(source: KnowledgeSource): KnowledgeSource {
  return { ...source, timestamp: new Date(source.timestamp) };
}

function serializeEntries(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  return entries.map((entry) => ({
    ...entry,
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
    source: serializeSource(entry.source),
  }));
}
