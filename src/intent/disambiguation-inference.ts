import type { LLMProvider } from '../adapter/llm-provider.js';
import type { InjectedContextEntry } from './context-injection-types.js';
import type { Interpretation } from './disambiguation-types.js';
import { extractJsonBlock } from '../extraction/extraction-utils.js';

export interface DisambiguationInferenceRequest {
  input: string;
  evidence: InjectedContextEntry[];
  limit: number;
}

export interface DisambiguationInferenceResult {
  interpretations: Interpretation[];
  selectedIndex?: number;
  clarificationQuestion?: string;
  clarificationOptions?: string[];
  clarificationReason?: string;
}

interface LLMInterpretationCandidate {
  meaning?: string;
  confidence?: number;
  evidenceIds?: string[];
}

interface LLMPayload {
  interpretations?: LLMInterpretationCandidate[];
  selectedIndex?: number;
  clarificationQuestion?: string;
  clarificationOptions?: string[];
  clarificationReason?: string;
}

export class DisambiguationInference {
  constructor(private readonly llmProvider: LLMProvider) {}

  async infer(request: DisambiguationInferenceRequest): Promise<DisambiguationInferenceResult> {
    const prompt = buildPrompt(request);
    const raw = await this.llmProvider.complete(prompt);
    const parsed = extractJsonBlock(raw);
    return normalizePayload(parsed, request.evidence, request.limit);
  }
}

function buildPrompt(request: DisambiguationInferenceRequest): string {
  const evidenceLines = request.evidence.length === 0
    ? ['[]']
    : request.evidence.map((entry, index) => [
        `${index + 1}. id=${entry.entryId}`,
        `type=${entry.type}`,
        `title=${entry.title}`,
        `summary=${entry.summary}`,
        `relevance=${entry.relevance.toFixed(3)}`,
        `confidence=${entry.confidence.toFixed(3)}`,
        `source=${entry.source.label}`,
      ].join(' | '));

  return [
    'You are an intent disambiguation engine.',
    'Given a possibly ambiguous user input and historical knowledge evidence, infer the most likely interpretations.',
    'Return JSON only.',
    'Schema:',
    '{',
    '  "interpretations": [{"meaning":"string","confidence":0.0,"evidenceIds":["entry-id"]}],',
    '  "selectedIndex": 0,',
    '  "clarificationQuestion": "string",',
    '  "clarificationOptions": ["string"],',
    '  "clarificationReason": "string"',
    '}',
    'Rules:',
    '- Use the evidence IDs provided; do not invent IDs.',
    '- If evidence is weak or conflicting, still return candidate interpretations, but include clarification fields.',
    `- Return at most ${request.limit} interpretations.`,
    '- Confidence must be between 0 and 1.',
    '- Prefer historical decisions and user preferences when they directly apply.',
    '',
    `User input: ${request.input}`,
    'Evidence:',
    ...evidenceLines,
  ].join('\n');
}

function normalizePayload(
  raw: unknown,
  evidence: InjectedContextEntry[],
  limit: number
): DisambiguationInferenceResult {
  const payload = isRecord(raw) ? raw as LLMPayload : {};
  const interpretations = normalizeInterpretations(payload.interpretations, evidence).slice(0, limit);

  return {
    interpretations,
    selectedIndex: normalizeSelectedIndex(payload.selectedIndex, interpretations.length),
    clarificationQuestion: normalizeOptionalString(payload.clarificationQuestion),
    clarificationOptions: normalizeStringArray(payload.clarificationOptions),
    clarificationReason: normalizeOptionalString(payload.clarificationReason),
  };
}

function normalizeInterpretations(
  candidates: LLMPayload['interpretations'],
  evidence: InjectedContextEntry[]
): Interpretation[] {
  if (!Array.isArray(candidates)) {
    return [];
  }

  const evidenceMap = new Map(evidence.map((entry) => [entry.entryId, entry]));

  return candidates
    .filter(isRecord)
    .map((candidate) => {
      const evidenceIds = Array.isArray(candidate.evidenceIds)
        ? candidate.evidenceIds.map((value) => String(value).trim()).filter(Boolean)
        : [];

      return {
        meaning: normalizeOptionalString(candidate.meaning) ?? '',
        confidence: clampConfidence(candidate.confidence),
        evidence: evidenceIds
          .map((id) => evidenceMap.get(id))
          .filter((entry): entry is InjectedContextEntry => entry !== undefined),
      } satisfies Interpretation;
    })
    .filter((candidate) => candidate.meaning.length > 0);
}

function normalizeSelectedIndex(value: unknown, length: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.floor(value);
  return normalized >= 0 && normalized < length ? normalized : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);

  return normalized.length > 0 ? normalized : undefined;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}
