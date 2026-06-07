/**
 * FR-1 AC-1.1~1.7, FR-2 AC-2.1~2.7
 * Shared types for KIVO LLM Wiki collection, storage, and organization.
 */

export type WikiEntryType = 'wiki_space' | 'wiki_directory' | 'wiki_page';
export type WikiNodeType = 'space' | 'directory' | 'page';
export type WikiSourceType = 'url' | 'document' | 'research' | 'feishu' | 'web';
export type WikiDraftStatus = 'pending_confirmation' | 'confirmed' | 'discarded' | 'failed';
export type WikiNodeStatus = 'active' | 'draft' | 'archived';

export interface LLMRequest {
  model: string;
  prompt: string;
  content: string;
  signal?: AbortSignal;
}

export interface LLMAdapter {
  complete(request: LLMRequest): Promise<string>;
}

export interface EmbeddingAdapter {
  embed(content: string, options?: { signal?: AbortSignal }): Promise<number[]>;
}

export interface CollectorContext {
  model: string;
  llm: LLMAdapter;
  embedder?: EmbeddingAdapter;
  now?: Date;
  timeoutMs?: number;
}

export interface WikiTagRecord {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  createdAt: string;
}

export interface WikiPageVersionRecord {
  id: string;
  pageId: string;
  version: number;
  title: string;
  content: string;
  summary: string;
  tags: string[];
  metadata: WikiNodeMetadata;
  createdAt: string;
}

export interface WikiSourceRef {
  type: WikiSourceType;
  uri?: string;
  fileName?: string;
  mimeType?: string;
  collectedAt: string;
}

export interface WikiPageSection {
  title: string;
  level: number;
  content: string;
}

export interface WikiLinkRef {
  label: string;
  targetTitle: string;
  targetPageId?: string;
  status: 'resolved' | 'missing';
}

export interface WikiDraft {
  id: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  sections: WikiPageSection[];
  links: WikiLinkRef[];
  suggestedParentTitle?: string;
  suggestedSpaceId?: string;
  source: WikiSourceRef;
  rawContent: string;
  llmOutput: Record<string, unknown>;
  status: WikiDraftStatus;
  errors: string[];
  warnings: string[];
  createdAt: string;
}

export interface WikiDraftInput {
  title?: string;
  content: string;
  source: WikiSourceRef;
  spaceId?: string;
}

export interface WikiNodeMetadata {
  source?: WikiSourceRef;
  tags?: string[];
  summary?: string;
  links?: WikiLinkRef[];
  sections?: WikiPageSection[];
  embeddingStatus?: 'ready' | 'failed' | 'pending';
  syncStatus?: 'ok' | 'error' | 'stale';
  error?: string;
  warnings?: string[];
  extra?: Record<string, unknown>;
}

export interface WikiEntryRecord {
  id: string;
  type: WikiEntryType;
  title: string;
  content: string;
  summary: string;
  parentId: string | null;
  sortOrder: number;
  status: WikiNodeStatus;
  tags: string[];
  metadata: WikiNodeMetadata;
  embedding?: number[] | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface WikiTreeNode extends WikiEntryRecord {
  nodeType: WikiNodeType;
  children: WikiTreeNode[];
}

export interface CreateSpaceInput {
  title: string;
  summary?: string;
  description?: string;
  metadata?: WikiNodeMetadata;
}

export interface UpdateSpaceInput {
  title?: string;
  summary?: string;
  content?: string;
  metadata?: WikiNodeMetadata;
  status?: WikiNodeStatus;
}

export interface CreateDirectoryInput {
  title: string;
  parentId: string;
  summary?: string;
  metadata?: WikiNodeMetadata;
  sortOrder?: number;
}

export interface CreatePageInput {
  title: string;
  content: string;
  parentId: string;
  summary?: string;
  tags?: string[];
  metadata?: WikiNodeMetadata;
  embedding?: number[] | null;
  sortOrder?: number;
}

export interface UpdatePageInput {
  title?: string;
  content?: string;
  summary?: string;
  parentId?: string | null;
  tags?: string[];
  metadata?: WikiNodeMetadata;
  embedding?: number[] | null;
  status?: WikiNodeStatus;
  sortOrder?: number;
}

export interface WikiCollectionResult {
  draft: WikiDraft;
  durationMs: number;
}

export interface UrlCollectInput {
  url: string;
  spaceId?: string;
  timeoutMs?: number;
}

export interface DocumentCollectInput {
  fileName: string;
  content: string | Uint8Array;
  mimeType?: string;
  spaceId?: string;
}

export interface ResearchCollectInput {
  title: string;
  report: string;
  sourceUri?: string;
  sectionHints?: string[];
  spaceId?: string;
}

export interface ConfirmDraftInput {
  draft: WikiDraft;
  parentId: string;
  title?: string;
  summary?: string;
  content?: string;
  tags?: string[];
  replacePageId?: string;
}

export interface WikiLinkRecord {
  sourcePageId: string;
  targetPageId: string | null;
  targetTitle: string;
  label: string;
  status: 'resolved' | 'missing';
  createdAt: string;
  updatedAt: string;
}

export interface WikiCommunitySuggestion {
  id: string;
  pageIds: string[];
  communityKey: string;
  score: number;
  createdAt: string;
}

export interface GraphSignalWeights {
  coOccurrence: number;
  semanticSimilarity: number;
  citation: number;
  timeDecay: number;
}

// --- Audio/Video Transcription Types ---

export interface TranscribeOptions {
  /** Language code (e.g., 'zh', 'en'). Defaults to 'zh'. */
  language?: string;
  /** Whisper model size. Defaults to 'base'. */
  model?: 'tiny' | 'base';
  /** Whether to include timestamped segments. */
  includeSegments?: boolean;
  /** Source path for preserving original media on failure. */
  sourceMediaPath?: string;
  /** Single-file size limit. Defaults to FR-A02 50MB import limit. */
  maxFileSizeBytes?: number;
  /** Single transcribed segment duration limit in seconds. */
  maxSegmentDurationSeconds?: number;
}

export interface TranscribeResult {
  /** Full transcribed text. */
  text: string;
  /** Detected or specified language. */
  language: string;
  /** Duration of the audio in seconds. */
  durationSeconds: number;
  /** Timestamped segments, if requested. */
  segments?: Array<{
    start: number;
    end: number;
    text: string;
  }>;
}

/** Multimodal collection input — supports PDF, images, video, audio, text */
export interface MultimodalCollectInput {
  fileName: string;
  mimeType: string;
  content: string | Uint8Array;
  spaceId?: string;
  timeoutMs?: number;
  sourceMediaPath?: string;
  sourceChannel?: 'feishu' | 'web' | 'url' | string;
  sourceRef?: string;
  /** FR-A02 FR-C AC5 — when set, only re-extract the specified video channel during reprocess. */
  retryChannel?: VideoChannelName;
}

export type UploadRouteChannel = 'image' | 'audio' | 'video' | 'document' | 'unsupported';
export type UploadRouteStatus = 'ready' | 'unsupported';

export interface UploadRouteDecision {
  channel: UploadRouteChannel;
  status: UploadRouteStatus;
  mimeType: string;
  extension?: string;
  conflict: boolean;
  conflictLog?: string;
  parseParams: Record<string, unknown>;
  userMessage?: string;
}

export interface MaterialRouteMetadata {
  materialId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  status: UploadRouteStatus;
  spaceId: string;
  storagePath: string;
  sourceChannel: string;
  sourceRef?: string;
  route: UploadRouteDecision;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

/** Result from multimodal routing */
export type VideoChannelName = 'audio' | 'keyframe' | 'text';

/** Result from multimodal routing */
export interface MultimodalTextFragment {
  text: string;
  sourceMediaPath?: string;
  startSeconds?: number;
  endSeconds?: number;
  frameIndex?: number;
  timestampSeconds?: number;
  coordinates?: unknown;
  /** FR-A02 FR-C — per-fragment source channel ('audio' | 'keyframe' | 'text') */
  channel?: string;
  /** FR-A02 FR-C — flag fragments judged as duplicate by the router (excluded from staging).
   *  Truthy value; may carry a descriptive reason string (e.g. 'audio-overlap-100pct'). */
  duplicateMarker?: boolean | string;
}

export interface MultimodalRouteResult {
  category: 'pdf' | 'image' | 'video' | 'audio' | 'text' | 'unknown';
  route?: UploadRouteDecision;
  material?: MaterialRouteMetadata;
  extractedText: string;
  metadata: Record<string, unknown>;
  draft?: WikiDraft;
  warnings: string[];
  fragments?: MultimodalTextFragment[];
  /** FR-A02 FR-C AC5 — per-channel failure details for video materials. */
  channelFailures?: Array<{
    channel: string;
    error: string;
    [key: string]: unknown;
  }>;
}
