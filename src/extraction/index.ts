/**
 * Extraction module — knowledge extraction pipeline (FR-A01/A02/A03/A04).
 *
 * Provides conversation extraction, document extraction, rule extraction,
 * personal knowledge input, analysis artifacts, and a small orchestrator.
 */

export {
  ConversationExtractor,
  type ConversationExtractorOptions,
  type ConversationExtractionResult,
  type ConversationMessage,
} from './conversation-extractor.js';

export {
  MarkdownParser,
  PlainTextParser,
  type DocumentParser,
  type ParsedSection,
  type Frontmatter,
} from './document-parser.js';

export {
  DocumentExtractor,
  detectDocumentFormat,
  type DocumentExtractorOptions,
  type DocumentExtractionResult,
  type DocumentMetadata,
  type DocumentFormat,
} from './document-extractor.js';

export {
  RuleExtractor,
  type RuleEntry,
  type RuleExtractorOptions,
  type RulePriority,
  type RuleChangeEvent,
  type RuleConflict,
} from './rule-extractor.js';

export {
  ExtractionPipeline,
  type ExtractionPipelineOptions,
} from './pipeline.js';

export {
  ChunkStrategy,
  type ChunkOptions,
  type Chunk,
} from './chunk-strategy.js';

export {
  createAnalysisArtifact,
  type AnalysisArtifact,
  type ArtifactSourceType,
  type CandidateEntity,
  type ConceptSuggestion,
  type AssociationSuggestion,
  type ConflictSuggestion,
  type ResearchSuggestion,
} from './analysis-artifact.js';

export {
  OpenAILLMProvider,
  type OpenAILLMProviderOptions,
} from './llm-extractor.js';

export {
  PersonalKnowledgeInput,
  type PersonalKnowledgeInputOptions,
  type ManualEntryInput,
  type FileImportInput,
  type UrlImportInput,
  type ConversationMarkInput,
  type BatchFolderInput,
  type BatchImportProgress,
  type ProgressCallback,
} from './personal-input.js';

export {
  BgeEmbedder,
} from './bge-embedder.js';
