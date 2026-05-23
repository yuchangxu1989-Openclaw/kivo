import type { LLMProvider } from '../adapter/llm-provider.js';
import type { ConversationMessage } from '../extraction/conversation-extractor.js';
import { extractJsonBlock, generateTitle, shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import { buildDetectionPrompt, buildSingleMessageDetectionPrompt } from './detection-prompt.js';
import {
  BUILTIN_SIGNAL_TYPE_REGISTRY,
  DEFAULT_SIGNAL_CONFIG,
  type DetectedSignal,
  type IntentSignal,
  type IntentSignalType,
  type SignalDetectorConfig,
  type SignalTypeDefinition,
} from './signal-types.js';

export interface SignalDetectorOptions {
  llmProvider: LLMProvider;
  config?: Partial<SignalDetectorConfig>;
}

class SignalTypeRegistry {
  private readonly definitions = new Map<string, SignalTypeDefinition>();

  constructor(definitions: SignalTypeDefinition[]) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: SignalTypeDefinition): void {
    const type = String(definition.type).trim();
    if (!type) return;
    this.definitions.set(type, {
      ...definition,
      type: type as IntentSignalType,
      positiveExamples: definition.positiveExamples ?? [],
      negativeExamples: definition.negativeExamples ?? [],
    });
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }

  getEnabled(types: IntentSignalType[]): SignalTypeDefinition[] {
    return types
      .map(type => this.definitions.get(String(type)))
      .filter((definition): definition is SignalTypeDefinition => definition !== undefined);
  }
}

/**
 * SignalDetector — LLM-driven intent signal detection.
 *
 * Covers all FR-E03 built-in signals:
 * correction, emphasis, declaration, rule, preference, decision, constraint,
 * methodology, lesson_learned, fact_update, with backward-compatible
 * experience support. Custom L2 signal definitions can be registered through
 * config.customTypes and use the same prompt / parse / validation pipeline.
 *
 * All detection is LLM-driven — no keyword matching, regex, FTS5, or rule
 * engine is used for semantic understanding.
 */
export class SignalDetector {
  private readonly llm: LLMProvider;
  private readonly config: SignalDetectorConfig;
  private readonly registry: SignalTypeRegistry;

  constructor(options: SignalDetectorOptions) {
    this.llm = options.llmProvider;
    this.config = {
      ...DEFAULT_SIGNAL_CONFIG,
      ...options.config,
      enabledTypes: options.config?.enabledTypes ?? DEFAULT_SIGNAL_CONFIG.enabledTypes,
      customTypes: options.config?.customTypes ?? [],
      maxSignalsPerConversation: options.config?.maxSignalsPerConversation ?? DEFAULT_SIGNAL_CONFIG.maxSignalsPerConversation,
    };
    this.registry = new SignalTypeRegistry(Object.values(BUILTIN_SIGNAL_TYPE_REGISTRY));
    for (const customType of this.config.customTypes ?? []) {
      this.registry.register(customType);
    }
  }

  /**
   * Detect intent signals from a single message string.
   * Optimized for real-time, per-message detection. Works in a single-agent
   * setup because it only needs the main conversation message text.
   */
  async detect(message: string): Promise<DetectedSignal[]> {
    if (!message.trim()) return [];

    const definitions = this.resolveEnabledDefinitions();
    const prompt = buildSingleMessageDetectionPrompt(message, this.config.enabledTypes, definitions);
    const raw = await this.llm.complete(prompt);
    return this.parseAndValidate(raw);
  }

  /**
   * Detect intent signals from a conversation (multiple messages).
   * Suitable for batch/cron extraction from conversation history.
   */
  async detectFromConversation(messages: ConversationMessage[]): Promise<DetectedSignal[]> {
    if (messages.length === 0) return [];

    const definitions = this.resolveEnabledDefinitions();
    const prompt = buildDetectionPrompt(messages, this.config.enabledTypes, definitions);
    const raw = await this.llm.complete(prompt);
    return this.parseAndValidate(raw);
  }

  private resolveEnabledDefinitions(): SignalTypeDefinition[] {
    return this.registry.getEnabled(this.config.enabledTypes);
  }

  private parseAndValidate(raw: string): DetectedSignal[] {
    const parsed = extractJsonBlock(raw);
    if (!Array.isArray(parsed)) return [];
    return this.filterAndValidate(parsed);
  }

  /**
   * Filter parsed signals by threshold and enabled types, validate structure.
   */
  private filterAndValidate(parsed: unknown[]): DetectedSignal[] {
    const signals: DetectedSignal[] = [];

    for (const item of parsed) {
      const signal = this.validateSignal(item);
      if (!signal) continue;
      if (signal.confidence < this.config.threshold) continue;
      if (!this.config.enabledTypes.includes(signal.type)) continue;
      signals.push(signal);
      if (signals.length >= this.config.maxSignalsPerConversation) break;
    }

    return signals;
  }

  /**
   * Validate and normalize a raw signal object from LLM output.
   */
  private validateSignal(raw: unknown): DetectedSignal | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    const type = typeof obj.type === 'string' ? obj.type.trim() : '';
    if (!type || !this.registry.has(type)) return null;

    const content = typeof obj.content === 'string' ? obj.content.trim() : '';
    if (!content) return null;

    return {
      type: type as IntentSignalType,
      confidence: typeof obj.confidence === 'number'
        ? Math.max(0, Math.min(1, obj.confidence))
        : 0.5,
      title: typeof obj.title === 'string'
        ? shortenKnowledgeTitle(obj.title, content)
        : generateTitle(content),
      content,
      positives: this.normalizeStringArray(obj.positives),
      negatives: this.normalizeStringArray(obj.negatives),
      sourceFragment: typeof obj.sourceFragment === 'string'
        ? obj.sourceFragment
        : '',
      reason: typeof obj.reason === 'string'
        ? obj.reason.trim()
        : '',
      tags: this.normalizeStringArray(obj.tags),
    };
  }

  private normalizeStringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((s): s is string => typeof s === 'string').map(s => s.trim()).filter(Boolean)
      : [];
  }
}

export type { IntentSignal };
