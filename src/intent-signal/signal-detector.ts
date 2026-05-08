import type { LLMProvider } from '../adapter/llm-provider.js';
import type { ConversationMessage } from '../extraction/conversation-extractor.js';
import { extractJsonBlock, generateTitle, shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import { buildDetectionPrompt } from './detection-prompt.js';
import {
  DEFAULT_SIGNAL_CONFIG,
  type IntentSignal,
  type IntentSignalType,
  type SignalDetectorConfig,
} from './signal-types.js';

export interface SignalDetectorOptions {
  llmProvider: LLMProvider;
  config?: Partial<SignalDetectorConfig>;
}

export class SignalDetector {
  private readonly llm: LLMProvider;
  private readonly config: SignalDetectorConfig;

  constructor(options: SignalDetectorOptions) {
    this.llm = options.llmProvider;
    this.config = { ...DEFAULT_SIGNAL_CONFIG, ...options.config };
  }

  async detect(messages: ConversationMessage[]): Promise<IntentSignal[]> {
    if (messages.length === 0) return [];

    const prompt = buildDetectionPrompt(messages, this.config.enabledTypes);
    const raw = await this.llm.complete(prompt);
    const parsed = extractJsonBlock(raw);

    if (!Array.isArray(parsed)) return [];

    const signals: IntentSignal[] = [];
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

  private validateSignal(raw: unknown): IntentSignal | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    const validTypes: IntentSignalType[] = [
      'correction', 'emphasis', 'declaration', 'rule', 'preference',
    ];
    if (!validTypes.includes(obj.type as IntentSignalType)) return null;

    const content = typeof obj.content === 'string' ? obj.content.trim() : '';
    if (!content) return null;

    return {
      type: obj.type as IntentSignalType,
      confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
      title: typeof obj.title === 'string' ? shortenKnowledgeTitle(obj.title, content) : generateTitle(content),
      content,
      positives: Array.isArray(obj.positives) ? obj.positives.filter((s): s is string => typeof s === 'string') : [],
      negatives: Array.isArray(obj.negatives) ? obj.negatives.filter((s): s is string => typeof s === 'string') : [],
      sourceFragment: typeof obj.sourceFragment === 'string' ? obj.sourceFragment : '',
      tags: Array.isArray(obj.tags) ? obj.tags.filter((s): s is string => typeof s === 'string') : [],
    };
  }
}
