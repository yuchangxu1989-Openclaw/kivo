import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../adapter/llm-provider.js';
import { Classifier } from '../pipeline/classifier.js';
import type { KnowledgeEntry, KnowledgeSource, KnowledgeType } from '../types/index.js';
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

export interface ConversationMessage {
  role: string;
  content: string;
  timestamp?: Date;
}

export type ConversationLLMProvider = LLMProvider;

export interface ConversationExtractorOptions {
  llmProvider: ConversationLLMProvider;
  classifier?: Classifier;
  minConfidence?: number;
  promptBuilder?: (messages: ConversationMessage[]) => string;
}

interface CandidateInput {
  type?: string;
  title?: string;
  content?: string;
  summary?: string;
  confidence?: number;
  tags?: string[];
}

export interface ConversationExtractionResult {
  entries: KnowledgeEntry[];
  artifact: AnalysisArtifact;
}

export class ConversationExtractor {
  private readonly llmProvider: ConversationLLMProvider;
  private readonly classifier: Classifier;
  private readonly minConfidence: number;
  private readonly promptBuilder: (messages: ConversationMessage[]) => string;

  constructor(options: ConversationExtractorOptions) {
    this.llmProvider = options.llmProvider;
    this.classifier = options.classifier ?? new Classifier();
    this.minConfidence = options.minConfidence ?? 0.5;
    this.promptBuilder = options.promptBuilder ?? defaultPromptBuilder;
  }

  async extract(
    messages: ConversationMessage[],
    source: KnowledgeSource,
    existingEntries: KnowledgeEntry[] = [],
  ): Promise<KnowledgeEntry[]> {
    const result = await this.extractWithArtifact(messages, source, existingEntries);
    return result.entries;
  }

  async extractWithArtifact(
    messages: ConversationMessage[],
    source: KnowledgeSource,
    existingEntries: KnowledgeEntry[] = [],
  ): Promise<ConversationExtractionResult> {
    if (messages.length === 0) {
      return { entries: [], artifact: createAnalysisArtifact('conversation', source) };
    }

    const prompt = this.promptBuilder(messages);
    const raw = await this.llmProvider.complete(prompt);
    const parsed = extractJsonBlock(raw);
    const candidates = normalizeKnowledgeCandidates(parsed);
    const entries: KnowledgeEntry[] = [];
    const dedupe = new Set(existingEntries.map(entry => dedupeKey(entry.type, entry.content)));

    const candidateEntities: CandidateEntity[] = [];

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
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

      const entry = await this.toKnowledgeEntry(candidate, source, messages, index);
      if (!entry) continue;
      if (isDuplicateEntry(entry, existingEntries)) continue;

      const key = dedupeKey(entry.type, entry.content);
      if (dedupe.has(key)) continue;

      dedupe.add(key);
      entries.push(entry);
    }

    const artifact = createAnalysisArtifact('conversation', source, {
      candidateEntities,
      metadata: { messageCount: messages.length },
    });

    return { entries, artifact };
  }

  private async toKnowledgeEntry(
    candidate: CandidateInput,
    source: KnowledgeSource,
    messages: ConversationMessage[],
    index: number,
  ): Promise<KnowledgeEntry | null> {
    const content = candidate.content?.trim();
    if (!content) return null;

    const classification = await this.classifier.classify(content);
    const type: KnowledgeType = isKnowledgeType(candidate.type) ? candidate.type : classification.type;
    const confidence = clampConfidence(candidate.confidence, classification.confidence);
    const now = new Date();
    const contextWindow = this.buildContextWindow(messages, content, index);

    return {
      id: randomUUID(),
      type,
      title: shortenKnowledgeTitle(candidate.title, content),
      content,
      summary: candidate.summary?.trim() || generateSummary(content),
      source: buildDerivedSource(source, contextWindow),
      confidence,
      status: confidence < this.minConfidence ? 'pending' : 'active',
      tags: uniqueTags(candidate.tags),
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
  }

  private buildContextWindow(messages: ConversationMessage[], content: string, index: number): string {
    const matchedIndex = messages.findIndex(message => message.content.includes(content.slice(0, Math.min(24, content.length))));
    const anchor = matchedIndex >= 0 ? matchedIndex : Math.min(index, Math.max(messages.length - 1, 0));
    const start = Math.max(0, anchor - 1);
    const end = Math.min(messages.length, anchor + 2);

    return messages
      .slice(start, end)
      .map(message => `${message.role}: ${message.content}`)
      .join('\n');
  }
}

function defaultPromptBuilder(messages: ConversationMessage[]): string {
  const transcript = messages
    .map((message, index) => `[${index}] ${message.role}: ${message.content}`)
    .join('\n');

  return [
    'Extract structured knowledge from the conversation.',
    'Return JSON only.',
    'Schema: [{"type":"fact|methodology|decision|experience|intent|meta","title":"简短标题（≤50字符）","content":"string","summary":"string","confidence":0.0,"tags":["string"]}]',
    'Title rule: title must be concise and no longer than 50 characters. If the content is long, summarize the title instead of copying the full content.',
    'Keep only durable knowledge. Skip chit-chat, acknowledgements, and repetition.',
    'Conversation:',
    transcript,
  ].join('\n\n');
}
