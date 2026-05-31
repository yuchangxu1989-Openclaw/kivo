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
  similar_sentences?: string[];
  similarSentences?: string[];
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
      subjectId: source.subjectId,
      confidence,
      status: 'active',
      tags: uniqueTags(candidate.tags),
      similarSentences: normalizeSimilarSentences(candidate),
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

function defaultPromptBuilder(messages: ConversationMessage[]): string {
  const transcript = messages
    .map((message, index) => `[${index}] ${message.role}: ${message.content}`)
    .join('\n');

  return [
    '从对话中萃取可长期复用的结构化知识。返回纯 JSON。',
    '知识定义：知识是经过抽象、聚合、萃取后的长效理解模型，必须跨时间、跨场景可复用，并能回答「它让 agent 在什么场景下避免什么错误」。',
    '禁止提取：任务派发指令、一次性调度安排、排查步骤记录、临时优先级决策、行为铁律/操作规则、具体文件路径、命令行、配置片段、未经抽象的事件记录。',
    '三重测试：1）三个月后还有价值；2）换项目/团队/场景仍适用；3）去掉具体人名、项目名、时间后仍是理解模型。任一不通过就返回 [] 或丢弃该条。',
    '抽象归纳要求：title 不能照搬原文，必须由 LLM 归纳为 ≤30 字的跨场景短标题；content 不能照搬原文，必须说明场景、原则、原因。',
    'similar_sentences：每条知识必须生成 2-3 条泛化相似表述，用于后续语义检索匹配，不要复制原句。',
    'Schema: [{"type":"fact|methodology|decision|experience|intent|meta","title":"≤30字抽象短标题","content":"场景+原则+原因","summary":"一句话摘要","confidence":0.0,"tags":["string"],"similar_sentences":["泛化表述1","泛化表述2"]}]',
    'Conversation:',
    transcript,
  ].join('\n\n');
}
