import type { KnowledgeRepository, SearchResult as RepositorySearchResult } from '../repository/index.js';
import type { LLMProvider } from '../adapter/llm-provider.js';
import { ContextInjector, type ContextInjectorOptions } from './context-injector.js';
import { DisambiguationInference } from './disambiguation-inference.js';
import type {
  ClarificationSuggestion,
  DisambiguationRequest,
  DisambiguationResult,
  Interpretation,
} from './disambiguation-types.js';
import type { InjectedContextEntry } from './context-injection-types.js';

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_LIMIT = 6;
const DISAMBIGUATION_BUDGET = 800;
const MEANING_KEYWORDS = ['meaning', 'means', '指的是', '意思', '还是', 'or'];
const PREFERENCE_HINTS = ['prefer', '偏好', '习惯', '风格', '喜欢'];
const DECISION_HINTS = ['decide', 'decision', '约定', '规则', '默认'];

export interface DisambiguatorOptions extends ContextInjectorOptions {
  repository: KnowledgeRepository;
  llmProvider?: LLMProvider;
}

export class Disambiguator {
  private readonly repository: KnowledgeRepository;
  private readonly injector: ContextInjector;
  private readonly inference?: DisambiguationInference;

  constructor(options: DisambiguatorOptions) {
    this.repository = options.repository;
    this.injector = new ContextInjector(options);
    this.inference = options.llmProvider ? new DisambiguationInference(options.llmProvider) : undefined;
  }

  async disambiguate(request: DisambiguationRequest): Promise<DisambiguationResult> {
    const input = request.input.trim();
    if (!input) {
      return {
        interpretations: [],
        clarification: {
          question: '你希望我先澄清哪一部分？',
          options: ['目标对象', '操作动作', '范围边界'],
          reason: '输入为空，无法推断稳定意图。',
          evidence: [],
        },
        resolutionMode: this.inference ? 'llm' : 'fallback',
        fallbackReason: this.inference ? undefined : '未配置 LLM，无法执行推理消歧。',
      };
    }

    const confidenceThreshold = normalizeThreshold(
      request.confidenceThreshold,
      DEFAULT_CONFIDENCE_THRESHOLD
    );
    const limit = normalizePositiveInteger(request.limit, DEFAULT_LIMIT);
    const evidence = await this.loadEvidence(input, request.preferredTypes, limit);

    if (this.inference) {
      try {
        const inferred = await this.inference.infer({
          input,
          evidence,
          limit,
        });
        const interpretations = inferred.interpretations.slice(0, limit);
        const selected = inferred.selectedIndex !== undefined ? interpretations[inferred.selectedIndex] : interpretations[0];
        const clarification = buildClarificationFromInference(input, evidence, interpretations, inferred);

        if (!selected || selected.confidence < confidenceThreshold || isAmbiguous(selected, interpretations) || clarification) {
          return {
            interpretations,
            clarification: clarification ?? buildClarification(input, evidence, interpretations),
            resolutionMode: 'llm',
          };
        }

        return {
          interpretations,
          selected,
          resolutionMode: 'llm',
        };
      } catch {
        // Explicit fallback: keep service available when LLM path fails.
      }
    }

    const interpretations = buildInterpretations(input, evidence).slice(0, limit);
    const selected = interpretations[0];

    if (!selected || selected.confidence < confidenceThreshold || isAmbiguous(selected, interpretations)) {
      return {
        interpretations,
        clarification: buildClarification(input, evidence, interpretations),
        resolutionMode: 'fallback',
        fallbackReason: this.inference
          ? 'LLM 消歧失败，已降级到关键词/规则启发式。'
          : '未配置 LLM，使用关键词/规则启发式消歧。',
      };
    }

    return {
      interpretations,
      selected,
      resolutionMode: 'fallback',
      fallbackReason: this.inference
        ? 'LLM 消歧失败，已降级到关键词/规则启发式。'
        : '未配置 LLM，使用关键词/规则启发式消歧。',
    };
  }

  private async loadEvidence(
    input: string,
    preferredTypes: DisambiguationRequest['preferredTypes'],
    limit: number
  ): Promise<InjectedContextEntry[]> {
    const injected = await this.injector.inject({
      query: input,
      tokenBudget: DISAMBIGUATION_BUDGET,
      preferredTypes,
      limit,
      minRelevance: 0,
    });

    if (injected.entries.length > 0) {
      return injected.entries;
    }

    const fallback = await this.repository.search({
      text: input,
      filters: preferredTypes ? { types: preferredTypes } : undefined,
      topK: limit,
      minScore: 0,
    });

    return fallback.slice(0, limit).map((result) => ({
      entryId: result.entry.id,
      title: result.entry.title,
      type: result.entry.type,
      summary: result.entry.summary || result.entry.content,
      confidence: clamp(result.entry.confidence),
      relevance: clamp(result.score),
      estimatedTokens: 0,
      source: {
        type: result.entry.source.type,
        reference: result.entry.source.reference,
        timestamp: new Date(result.entry.source.timestamp),
        agent: result.entry.source.agent,
        label: [result.entry.source.type, result.entry.source.reference].join(' | '),
      },
    }));
  }
}

function buildInterpretations(input: string, evidence: InjectedContextEntry[]): Interpretation[] {
  const ranked = evidence
    .map((entry, index) => ({
      entry,
      score: scoreEvidence(input, entry, index),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked.map(({ entry, score }) => ({
    meaning: deriveMeaning(input, entry),
    confidence: clamp(score),
    evidence: [entry],
  }));
}

function scoreEvidence(input: string, entry: InjectedContextEntry, index: number): number {
  const lower = input.toLowerCase();
  let score = entry.relevance * 0.45 + entry.confidence * 0.25;

  if (entry.type === 'decision') {
    score += 0.2;
  }
  if (entry.type === 'intent') {
    score += 0.15;
  }
  if (entry.type === 'experience' || entry.type === 'methodology') {
    score += 0.05;
  }
  if (containsAny(lower, DECISION_HINTS) && entry.type === 'decision') {
    score += 0.1;
  }
  if (containsAny(lower, PREFERENCE_HINTS) && (entry.type === 'intent' || entry.type === 'experience')) {
    score += 0.1;
  }
  if (containsAny(lower, MEANING_KEYWORDS)) {
    score += 0.05;
  }

  score -= index * 0.03;
  return clamp(score);
}

function deriveMeaning(input: string, entry: InjectedContextEntry): string {
  if (entry.type === 'decision') {
    return `${input} 更可能对应既有决策：${entry.summary}`;
  }
  if (entry.type === 'intent') {
    return `${input} 更可能是在延续用户偏好：${entry.summary}`;
  }
  if (entry.type === 'experience') {
    return `${input} 更可能在复用过往经验：${entry.summary}`;
  }
  return `${input} 更可能在指向这条知识：${entry.summary}`;
}

function isAmbiguous(selected: Interpretation, interpretations: Interpretation[]): boolean {
  if (interpretations.length <= 1) {
    return false;
  }

  const runnerUp = interpretations[1];
  return Math.abs(selected.confidence - runnerUp.confidence) < 0.12;
}

function buildClarification(
  input: string,
  evidence: InjectedContextEntry[],
  interpretations: Interpretation[]
): ClarificationSuggestion {
  const topEvidence = evidence.slice(0, 2);
  const options = interpretations.slice(0, 3).map((item) => item.meaning);

  if (options.length === 0) {
    return {
      question: `你说的“${input}”更偏向哪个方向？`,
      options: ['目标对象', '执行动作', '约束条件'],
      reason: '缺少足够的历史决策或偏好证据，继续猜测风险高。',
      evidence: topEvidence,
    };
  }

  return {
    question: `你这次的“${input}”更接近下面哪种理解？`,
    options,
    reason: '现有证据支持多个方向，最高候选之间差距不足以直接替你定论。',
    evidence: topEvidence,
  };
}

function buildClarificationFromInference(
  input: string,
  evidence: InjectedContextEntry[],
  interpretations: Interpretation[],
  inferred: {
    clarificationQuestion?: string;
    clarificationOptions?: string[];
    clarificationReason?: string;
  }
): ClarificationSuggestion | undefined {
  const hasStructuredClarification = Boolean(
    inferred.clarificationQuestion || (inferred.clarificationOptions && inferred.clarificationOptions.length > 0)
  );

  if (!hasStructuredClarification) {
    return undefined;
  }

  return {
    question: inferred.clarificationQuestion?.trim() || `你这次的“${input}”更接近哪个方向？`,
    options: inferred.clarificationOptions && inferred.clarificationOptions.length > 0
      ? inferred.clarificationOptions
      : interpretations.slice(0, 3).map((item) => item.meaning),
    reason: inferred.clarificationReason?.trim() || 'LLM 判断当前证据不足以直接定论。',
    evidence: evidence.slice(0, 2),
  };
}

function containsAny(input: string, keywords: string[]): boolean {
  return keywords.some((keyword) => input.includes(keyword));
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeThreshold(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return clamp(value);
}

function clamp(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
