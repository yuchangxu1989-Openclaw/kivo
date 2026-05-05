import type { KnowledgeEntry, KnowledgeSource } from '../types/index.js';
import { ConversationExtractor, type ConversationExtractorOptions, type ConversationMessage } from './conversation-extractor.js';
import { DocumentExtractor, type DocumentExtractorOptions, type DocumentMetadata } from './document-extractor.js';
import { RuleExtractor, type RuleEntry, type RuleExtractorOptions } from './rule-extractor.js';

export interface ExtractionPipelineOptions {
  conversation?: ConversationExtractorOptions;
  document?: DocumentExtractorOptions;
  rule?: RuleExtractorOptions;
}

export class ExtractionPipeline {
  private readonly conversationExtractor?: ConversationExtractor;
  private readonly documentExtractor: DocumentExtractor;
  private readonly ruleExtractor: RuleExtractor;

  constructor(options: ExtractionPipelineOptions = {}) {
    this.conversationExtractor = options.conversation
      ? new ConversationExtractor(options.conversation)
      : undefined;
    this.documentExtractor = new DocumentExtractor(options.document);
    this.ruleExtractor = new RuleExtractor(options.rule);
  }

  async extractFromConversation(
    messages: ConversationMessage[],
    source: KnowledgeSource,
    existingEntries: KnowledgeEntry[] = [],
  ): Promise<KnowledgeEntry[]> {
    if (!this.conversationExtractor) {
      throw new Error('Conversation extractor unavailable: provide conversation.llmProvider');
    }
    return this.conversationExtractor.extract(messages, source, existingEntries);
  }

  async extractFromDocument(
    markdown: string,
    metadata: DocumentMetadata,
    source: KnowledgeSource,
    existingEntries: KnowledgeEntry[] = [],
  ): Promise<KnowledgeEntry[]> {
    return this.documentExtractor.extractFromMarkdown(markdown, metadata, source, existingEntries);
  }

  async extractRules(text: string, source: KnowledgeSource): Promise<RuleEntry[]> {
    return this.ruleExtractor.extract(text, source);
  }

  async extractRuleKnowledge(text: string, source: KnowledgeSource): Promise<KnowledgeEntry[]> {
    const rules = await this.extractRules(text, source);
    return await this.ruleExtractor.toKnowledgeEntries(rules);
  }
}
