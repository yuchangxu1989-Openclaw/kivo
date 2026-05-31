/**
 * KIVO Core Type Definitions
 *
 * Six knowledge types (ADR-006): fact, methodology, decision, experience, intent, meta
 * Pipeline events and stages (ADR-001): Pipeline-Filter architecture
 * Task definition separation (ADR-005): KIVO defines tasks, host executes
 */

// ─── Knowledge Types ─────────────────────────────────────────────────────────

export type KnowledgeType =
  | 'fact'
  | 'methodology'
  | 'decision'
  | 'experience'
  | 'intent'
  | 'meta';

/**
 * Knowledge category — coarse-grained classification for routing and discovery.
 * Inspired by Vibe-Trading's 8-category enum; adapted for general knowledge management.
 */
export type KnowledgeCategory =
  | 'domain'       // domain-specific knowledge (business rules, product specs)
  | 'process'      // workflows, procedures, pipelines
  | 'reference'    // lookup data, glossaries, standards
  | 'analysis'     // analytical frameworks, evaluation criteria
  | 'tool'         // tool usage, CLI recipes, integration guides
  | 'strategy'     // strategic decisions, architectural choices
  | 'experience'   // lessons learned, post-mortems, case studies
  | 'meta';        // meta-knowledge about the knowledge system itself

export type EntryStatus = 'active' | 'pending_review' | 'superseded';

/**
 * Entry type — fine-grained domain-material classification (spec FR-P02-5).
 * Distinct from `KnowledgeType` (nature) and `KnowledgeCategory` (routing).
 * Used by subject wiki compilation and typed-entry validation.
 */
export const ENTRY_TYPES = ['concept', 'method', 'question', 'mistake', 'annotation'] as const;
export type EntryType = typeof ENTRY_TYPES[number];

export interface EmbeddingMetadata {
  status: 'ready' | 'pending_rebuild';
  modelId?: string;
  dimensions?: number;
  contentHash?: string;
  updatedAt?: Date;
  error?: string;
}

export interface KnowledgeMetadata {
  referenceCount?: number;
  externalValid?: boolean;
  domainData?: Record<string, unknown>;
  embedding?: EmbeddingMetadata;
  sourceRange?: SourceRange;
  sourceBadcase?: {
    materialId?: string;
    sessionId?: string;
    lineNumber?: number;
    filePath?: string;
  };
}

/**
 * SourceRange — exact original-document location for extracted knowledge.
 * Used by document import to trace every generated entry back to the source text.
 */
export interface SourceRange {
  /** Stable document identifier: file name, URL, URI, or external document ID. */
  documentId: string;
  /** 1-based page number when the source format exposes pages. */
  page?: number;
  /** 1-based paragraph index or inclusive paragraph range. */
  paragraph?: number | { start: number; end: number };
  /** Heading/chapter/section label when available. */
  section?: string;
  /** Exact source text used to derive this knowledge entry. */
  originalText: string;
}

/**
 * Dependency reference — a typed pointer to another knowledge entry or external resource.
 */
export interface DependencyRef {
  /** Target entry ID (for internal deps) or URI (for external deps) */
  ref: string;
  /** Relationship label */
  relation: 'requires' | 'extends' | 'contradicts' | 'supplements' | 'derived_from';
  /** Optional human-readable note */
  note?: string;
}

/**
 * I/O declaration — describes what a knowledge entry consumes and produces.
 * Inspired by Vibe-Trading's implicit I/O patterns, made explicit.
 */
export interface KnowledgeIO {
  /** Entry IDs or labels this entry depends on as input */
  inputs?: string[];
  /** Scenario labels or entry IDs that consume this entry's output */
  outputs?: string[];
}

/**
 * Nature dimension — what kind of knowledge this is (FR-B05).
 */
export type KnowledgeNature = 'fact' | 'decision' | 'methodology' | 'experience' | 'meta';

/**
 * Function dimension — how this knowledge is used (FR-B05).
 */
export type KnowledgeFunction =
  | 'constraint'
  | 'preference'
  | 'pattern'
  | 'principle';

export interface KnowledgeEntry {
  id: string;
  type: KnowledgeType;
  title: string;
  content: string;
  summary: string;
  source: KnowledgeSource;
  confidence: number; // 0-1
  status: EntryStatus;
  tags: string[];
  domain?: string;
  metadata?: KnowledgeMetadata;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  supersedes?: string; // id of entry this one replaces
  /** Original document location for traceable imports (FIX-09). */
  sourceRange?: SourceRange;

  // ── Enhanced fields (Vibe-Trading format analysis, 2026-05-03) ──────────

  /** Coarse-grained category for routing and discovery */
  category?: KnowledgeCategory;
  /** Explicit dependency declarations */
  dependencies?: DependencyRef[];
  /** I/O declarations: what this entry consumes and produces */
  io?: KnowledgeIO;
  /** Similar sentences / paraphrases for intent-type entries (5~10 items) */
  similarSentences?: string[];

  // ── Multi-dimensional tags (FR-B05) ─────────────────────────────────────

  /** Nature: fact / decision / methodology / experience / meta */
  nature?: KnowledgeNature;
  /** Function: constraint / preference / pattern / principle */
  functionTag?: KnowledgeFunction;
  /** Domain: open-ended domain label */
  knowledgeDomain?: string;

  // ── Subject-material association (FR-B03 AC7, FR-P02-5) ──────────────────

  /** Subject node ID this entry belongs to, propagated from the source material. */
  subjectId?: string;
  /** Fine-grained domain-material type: concept / method / question / mistake / annotation. */
  entryType?: EntryType;
}

export interface KnowledgeSource {
  type: 'conversation' | 'document' | 'research' | 'manual' | 'system';
  reference: string; // URI or identifier
  timestamp: Date;
  agent?: string; // which agent produced this
  context?: string; // surrounding context for traceability
  /** Source material ID this knowledge was extracted from (FR-B03 AC7). */
  materialId?: string;
  /** Subject node ID of the source material (FR-B03 AC7). */
  subjectId?: string;
}

// ─── Extraction Task (ADR-005) ───────────────────────────────────────────────

export type ExtractionTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ExtractionTask {
  id: string;
  status: ExtractionTaskStatus;
  input: string; // raw text to extract from
  source: KnowledgeSource;
  results: KnowledgeEntry[];
  createdAt: Date;
  completedAt?: Date;
  error?: string;
  artifactId?: string;
  failedStage?: PipelineStage;
  failureContext?: Record<string, unknown>;
}

// ─── Conflict Detection ──────────────────────────────────────────────────────
// ConflictRecord is defined in src/conflict/conflict-record.ts (canonical)

// ─── Pipeline (ADR-001) ──────────────────────────────────────────────────────

export type PipelineStage =
  | 'intake'       // raw input received
  | 'extraction'   // structured knowledge extracted
  | 'analysis_artifact' // structured semantic middle layer generated
  | 'classification' // knowledge type assigned
  | 'conflict_detection' // checked against existing entries
  | 'merge_detection' // duplicate / merge candidates checked
  | 'quality_gate' // low-value entries filtered before persistence
  | 'persistence'  // written to storage
  | 'complete'     // pipeline finished
  | (string & {}); // extensible custom stages

export type PipelineEventType =
  | 'task:created'
  | 'task:started'
  | 'stage:entered'
  | 'stage:completed'
  | 'stage:skipped'
  | 'entry:extracted'
  | 'conflict:detected'
  | 'conflict:resolved'
  | 'task:completed'
  | 'task:failed'
  | 'pipeline:error'
  | 'pipeline:warning';

export interface PipelineEvent {
  type: PipelineEventType;
  taskId: string;
  stage: PipelineStage;
  timestamp: Date;
  payload: Record<string, unknown>;
}
