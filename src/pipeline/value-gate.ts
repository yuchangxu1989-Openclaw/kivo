/**
 * ValueGate — LLM-based knowledge value assessment (FR-N04).
 *
 * Evaluates whether a knowledge entry fills a gap in LLM's native capabilities.
 * High-value: jargon, badcases, domain-specific rules, easy-to-forget constraints,
 *             complex intents, user shorthand.
 * Low-value: general common sense, things LLM already knows well.
 *
 * Also used at injection time (FR-E05 AC6) to filter out entries that don't
 * add value for the current query context.
 */

import { OpenAILLMProvider } from '../extraction/llm-extractor.js';
import { resolveLlmConfig } from '../cli/resolve-llm-config.js';
import { DEFAULT_VALUE_GATE_THRESHOLDS } from '../config/types.js';
import type { ValueGateThresholds } from '../config/types.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

export type ValueCategory =
  | 'jargon'              // 黑话/术语
  | 'badcase'             // 纠错/badcase
  | 'domain_rule'         // 领域定制规则
  | 'constraint'          // 易遗忘约束
  | 'complex_intent'      // 复杂意图
  | 'user_shorthand'      // 用户简写/缩写
  | 'common_knowledge'    // 通用常识（低价值）
  | 'llm_native';         // LLM 本来就会的（低价值）

export interface ValueAssessment {
  /** Whether this knowledge is high-value (fills LLM blind spot) */
  isHighValue: boolean;
  /** Assessed category */
  category: ValueCategory;
  /** Confidence of the assessment (0-1) */
  confidence: number;
  /** Brief reasoning from LLM */
  reasoning: string;
  /** Value dimensions evaluated */
  dimensions: {
    /** Is this private/proprietary knowledge? */
    privacy: number;
    /** Is this specific to a particular scenario? */
    scenarioSpecificity: number;
    /** Does this address a known LLM weakness? */
    llmBlindSpot: number;
  };
  /** When true, the assessment failed due to LLM unavailability and should be retried */
  requiresRetry?: boolean;
}

export interface InjectionValueAssessment {
  /** Whether this entry should be injected for the given query */
  shouldInject: boolean;
  /** Reasoning */
  reasoning: string;
}

// ── Quality Dimensions (FR-N05 Enhancement) ──────────────────────────────────

export interface QualityDimensions {
  atomicity: number;      // 原子性 (0-1)
  completeness: number;   // 完整性 (0-1)
  unambiguity: number;    // 无歧义性 (0-1)
  verifiability: number;  // 可验证性 (0-1)
  timeliness: number;     // 时效性 (0-1)
  uniqueness: number;     // 唯一性（默认 1.0，由 conflict-detector 覆盖）
  consistency: number;    // 一致性（默认 1.0，由 conflict-detector 覆盖）
}

export interface QualityAssessment {
  dimensions: QualityDimensions;
  overallScore: number;
  passesGate: boolean;    // overallScore >= 0.6
  failedDimensions: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const HIGH_VALUE_CATEGORIES: ValueCategory[] = [
  'jargon', 'badcase', 'domain_rule', 'constraint', 'complex_intent', 'user_shorthand',
];

const LOW_VALUE_CATEGORIES: ValueCategory[] = [
  'common_knowledge', 'llm_native',
];

const INGEST_VALUE_PROMPT = `你是一个知识价值评估引擎。判断给定知识是否填补了 LLM 的能力盲区。

评估三个维度（每个 0-1 分）：
1. privacy（私有性）：这是私有/专有知识吗？外部 LLM 训练数据中不太可能包含？
2. scenarioSpecificity（场景特异性）：这是特定场景/团队/项目才需要的知识吗？
3. llmBlindSpot（LLM 已知短板）：这是 LLM 容易出错或不知道的领域吗？

高价值类别（至少一个维度 ≥ 0.6）：
- jargon: 团队/行业黑话、内部术语、缩写
- badcase: LLM 曾经犯过的错误、纠错记录
- domain_rule: 领域定制规则、业务逻辑、特殊约定
- constraint: 容易被遗忘的约束、禁止事项、边界条件
- complex_intent: 复杂意图映射（用户说X实际想要Y）
- user_shorthand: 用户个人简写、缩写习惯

低价值类别（所有维度 < 0.4）：
- common_knowledge: 通用常识、公开信息、教科书内容
- llm_native: LLM 本来就擅长的（语法纠错、翻译、摘要等通用能力）

返回纯 JSON，格式：
{
  "category": "类别名",
  "confidence": 0.0-1.0,
  "reasoning": "一句话理由",
  "dimensions": { "privacy": 0.0-1.0, "scenarioSpecificity": 0.0-1.0, "llmBlindSpot": 0.0-1.0 }
}
不要包含 markdown 代码块标记。`;

const QUALITY_ASSESSMENT_PROMPT = `你是一个知识质量评估引擎。对给定知识条目进行多维质量评分。

评估以下维度（每个 0-1 分）：

质量维度：
1. atomicity（原子性）：这条知识是否只表达一个独立概念？多个概念混杂得分低。
2. completeness（完整性）：这条知识是否自包含、无需额外上下文即可理解？
3. unambiguity（无歧义性）：这条知识的表述是否清晰无歧义？模糊表述得分低。
4. verifiability（可验证性）：这条知识是否可以被验证或证伪？纯主观判断得分低。
5. timeliness（时效性）：这条知识是否具有持久价值？过时信息得分低。

价值维度（已有）：
6. privacy（私有性）：这是私有/专有知识吗？
7. scenarioSpecificity（场景特异性）：这是特定场景才需要的知识吗？
8. llmBlindSpot（LLM 已知短板）：这是 LLM 容易出错的领域吗？

同时判断知识类别：
- jargon / badcase / domain_rule / constraint / complex_intent / user_shorthand（高价值）
- common_knowledge / llm_native（低价值）

返回纯 JSON，格式：
{
  "category": "类别名",
  "confidence": 0.0-1.0,
  "reasoning": "一句话理由",
  "dimensions": { "privacy": 0.0-1.0, "scenarioSpecificity": 0.0-1.0, "llmBlindSpot": 0.0-1.0 },
  "quality": { "atomicity": 0.0-1.0, "completeness": 0.0-1.0, "unambiguity": 0.0-1.0, "verifiability": 0.0-1.0, "timeliness": 0.0-1.0 }
}
不要包含 markdown 代码块标记。`;

const INJECTION_VALUE_PROMPT = `你是一个注入价值判定引擎。判断一条知识在当前查询场景下是否值得注入。

判定标准：
- 如果这条知识是通用常识，即使语义匹配度高，也不应注入（LLM 自己就知道）
- 如果这条知识填补了 LLM 在当前场景下的能力盲区，应该注入
- 关键问题：去掉这条知识，LLM 的回答质量会下降吗？

返回纯 JSON：{"shouldInject": true/false, "reasoning": "一句话理由"}
不要包含 markdown 代码块标记。`;

// ── Runtime config loader (hot-reload: reads file every call) ────────────────

/**
 * Load valueGate thresholds from kivo.config.json in cwd.
 * Re-reads the file on every call to support runtime hot-update (FR-N04 AC5).
 * Falls back to DEFAULT_VALUE_GATE_THRESHOLDS when config is absent or malformed.
 */
export function loadValueGateThresholds(configDir?: string): Required<ValueGateThresholds> {
  const dir = configDir ?? process.cwd();
  const configPath = join(dir, 'kivo.config.json');
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      const t = raw?.valueGate?.thresholds;
      if (t && typeof t === 'object') {
        return {
          privacy: typeof t.privacy === 'number' ? Math.min(1, Math.max(0, t.privacy)) : DEFAULT_VALUE_GATE_THRESHOLDS.privacy,
          scenarioSpecificity: typeof t.scenarioSpecificity === 'number' ? Math.min(1, Math.max(0, t.scenarioSpecificity)) : DEFAULT_VALUE_GATE_THRESHOLDS.scenarioSpecificity,
          llmBlindSpot: typeof t.llmBlindSpot === 'number' ? Math.min(1, Math.max(0, t.llmBlindSpot)) : DEFAULT_VALUE_GATE_THRESHOLDS.llmBlindSpot,
        };
      }
    }
  } catch {
    // Config unreadable — use defaults
  }
  return { ...DEFAULT_VALUE_GATE_THRESHOLDS };
}

// ── Lazy LLM singleton ───────────────────────────────────────────────────────

let _llmProvider: OpenAILLMProvider | null = null;

function getLlmProvider(): OpenAILLMProvider {
  if (!_llmProvider) {
    const config = resolveLlmConfig();
    if ('error' in config) {
      throw new Error(config.error);
    }
    _llmProvider = new OpenAILLMProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutMs: 30_000,
    });
  }
  return _llmProvider;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseValueResponse(raw: string): ValueAssessment | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);

    const allCategories = [...HIGH_VALUE_CATEGORIES, ...LOW_VALUE_CATEGORIES];
    const category: ValueCategory = allCategories.includes(parsed.category)
      ? parsed.category
      : 'common_knowledge';

    const confidence = typeof parsed.confidence === 'number'
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.5;

    const dims = parsed.dimensions ?? {};
    const dimensions = {
      privacy: typeof dims.privacy === 'number' ? Math.min(1, Math.max(0, dims.privacy)) : 0,
      scenarioSpecificity: typeof dims.scenarioSpecificity === 'number' ? Math.min(1, Math.max(0, dims.scenarioSpecificity)) : 0,
      llmBlindSpot: typeof dims.llmBlindSpot === 'number' ? Math.min(1, Math.max(0, dims.llmBlindSpot)) : 0,
    };

    const isHighValue = HIGH_VALUE_CATEGORIES.includes(category);
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

    return { isHighValue, category, confidence, reasoning, dimensions };
  } catch {
    return null;
  }
}

function parseInjectionValueResponse(raw: string): InjectionValueAssessment | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      shouldInject: !!parsed.shouldInject,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  } catch {
    return null;
  }
}

// ── Threshold override ───────────────────────────────────────────────────────

/**
 * Apply score-based override: if any dimension exceeds its threshold,
 * promote to high-value regardless of LLM category (FR-N04 AC5).
 */
function applyThresholdOverride(
  assessment: ValueAssessment,
  thresholds: Required<ValueGateThresholds>,
): ValueAssessment {
  if (assessment.isHighValue) return assessment;

  const { dimensions } = assessment;
  const exceeded =
    dimensions.privacy >= thresholds.privacy ||
    dimensions.scenarioSpecificity >= thresholds.scenarioSpecificity ||
    dimensions.llmBlindSpot >= thresholds.llmBlindSpot;

  if (exceeded) {
    return {
      ...assessment,
      isHighValue: true,
      reasoning: `${assessment.reasoning} [score override: dimension exceeded threshold]`,
    };
  }
  return assessment;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Assess the value of a knowledge entry for ingest (FR-N04 AC1-AC4, AC6).
 * Returns whether the entry is high-value and its category.
 * Reads thresholds from kivo.config.json on every call (hot-reload, FR-N04 AC5).
 */
export async function assessIngestValue(
  title: string,
  content: string,
  configDir?: string,
): Promise<ValueAssessment> {
  try {
    const llm = getLlmProvider();
    const truncated = content.length > 2000 ? content.slice(0, 2000) : content;

    const prompt = `${INGEST_VALUE_PROMPT}\n\n知识标题：${title}\n知识内容：\n${truncated}`;
    const raw = await llm.complete(prompt);
    const result = parseValueResponse(raw);

    // Load thresholds fresh each call — no caching (hot-reload)
    const thresholds = loadValueGateThresholds(configDir);

    if (result) return applyThresholdOverride(result, thresholds);

    // Unparseable — reject to prevent unvetted entries
    console.warn(`[KIVO ValueGate] LLM 返回无法解析，拒绝条目 "${title}" (reason: llm_response_unparseable)`);
    return {
      isHighValue: false,
      category: 'common_knowledge',
      confidence: 0,
      reasoning: 'llm_response_unparseable',
      dimensions: { privacy: 0, scenarioSpecificity: 0, llmBlindSpot: 0 },
      requiresRetry: true,
    };
  } catch {
    // LLM unavailable — reject with retry flag
    console.warn(`[KIVO ValueGate] LLM 不可用，拒绝条目 "${title}" (reason: llm_unavailable_reject)`);
    return {
      isHighValue: false,
      category: 'common_knowledge',
      confidence: 0,
      reasoning: 'llm_unavailable_reject',
      dimensions: { privacy: 0, scenarioSpecificity: 0, llmBlindSpot: 0 },
      requiresRetry: true,
    };
  }
}

/**
 * Assess whether a matched entry should be injected for a given query (FR-E05 AC6).
 * Filters out common knowledge that LLM already knows, even if semantic similarity is high.
 */
export async function assessInjectionValue(
  query: string,
  entryTitle: string,
  entryContent: string,
): Promise<InjectionValueAssessment> {
  const llm = getLlmProvider();
  const truncatedContent = entryContent.length > 1500 ? entryContent.slice(0, 1500) : entryContent;

  const prompt = `${INJECTION_VALUE_PROMPT}\n\n当前查询：${query}\n\n匹配到的知识条目：\n标题：${entryTitle}\n内容：${truncatedContent}`;
  const raw = await llm.complete(prompt);
  const result = parseInjectionValueResponse(raw);

  if (result) return result;

  // Unparseable — default to inject to avoid dropping valuable knowledge
  return { shouldInject: true, reasoning: 'LLM 返回无法解析，默认注入' };
}

/**
 * Batch assess multiple entries (for audit-value CLI).
 * Returns assessments in the same order as input entries.
 * Passes configDir through for threshold hot-reload.
 */
export async function batchAssessValue(
  entries: Array<{ id: string; title: string; content: string }>,
  configDir?: string,
): Promise<Array<{ id: string; assessment: ValueAssessment }>> {
  const results: Array<{ id: string; assessment: ValueAssessment }> = [];

  for (const entry of entries) {
    const assessment = await assessIngestValue(entry.title, entry.content, configDir);
    results.push({ id: entry.id, assessment });
  }

  return results;
}

// ── Quality Assessment (FR-N05 Enhancement) ──────────────────────────────────

/** Default quality dimensions when LLM is unavailable */
const FALLBACK_QUALITY_DIMENSIONS: QualityDimensions = {
  atomicity: 0.5,
  completeness: 0.5,
  unambiguity: 0.5,
  verifiability: 0.5,
  timeliness: 0.5,
  uniqueness: 1.0,
  consistency: 1.0,
};

/**
 * Parse quality dimensions from the combined LLM response.
 */
function parseQualityResponse(raw: string): { quality: QualityDimensions; value: ValueAssessment } | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);

    // Parse value assessment (same as existing)
    const allCategories = [...HIGH_VALUE_CATEGORIES, ...LOW_VALUE_CATEGORIES];
    const category: ValueCategory = allCategories.includes(parsed.category)
      ? parsed.category
      : 'common_knowledge';

    const confidence = typeof parsed.confidence === 'number'
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.5;

    const dims = parsed.dimensions ?? {};
    const dimensions = {
      privacy: typeof dims.privacy === 'number' ? Math.min(1, Math.max(0, dims.privacy)) : 0,
      scenarioSpecificity: typeof dims.scenarioSpecificity === 'number' ? Math.min(1, Math.max(0, dims.scenarioSpecificity)) : 0,
      llmBlindSpot: typeof dims.llmBlindSpot === 'number' ? Math.min(1, Math.max(0, dims.llmBlindSpot)) : 0,
    };

    const isHighValue = HIGH_VALUE_CATEGORIES.includes(category);
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

    const value: ValueAssessment = { isHighValue, category, confidence, reasoning, dimensions };

    // Parse quality dimensions
    const q = parsed.quality ?? {};
    const quality: QualityDimensions = {
      atomicity: typeof q.atomicity === 'number' ? Math.min(1, Math.max(0, q.atomicity)) : 0.5,
      completeness: typeof q.completeness === 'number' ? Math.min(1, Math.max(0, q.completeness)) : 0.5,
      unambiguity: typeof q.unambiguity === 'number' ? Math.min(1, Math.max(0, q.unambiguity)) : 0.5,
      verifiability: typeof q.verifiability === 'number' ? Math.min(1, Math.max(0, q.verifiability)) : 0.5,
      timeliness: typeof q.timeliness === 'number' ? Math.min(1, Math.max(0, q.timeliness)) : 0.5,
      uniqueness: 1.0,   // Default; overridden by conflict-detector
      consistency: 1.0,  // Default; overridden by conflict-detector
    };

    return { quality, value };
  } catch {
    return null;
  }
}

/**
 * Compute overall quality score from dimensions.
 * Uses the 5 LLM-assessed dimensions (excludes uniqueness/consistency which are conflict-detector's domain).
 */
function computeOverallScore(dims: QualityDimensions): number {
  const scores = [dims.atomicity, dims.completeness, dims.unambiguity, dims.verifiability, dims.timeliness];
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

/**
 * Identify dimensions that failed (score < 0.4).
 */
function identifyFailedDimensions(dims: QualityDimensions): string[] {
  const failed: string[] = [];
  const entries: Array<[string, number]> = [
    ['atomicity', dims.atomicity],
    ['completeness', dims.completeness],
    ['unambiguity', dims.unambiguity],
    ['verifiability', dims.verifiability],
    ['timeliness', dims.timeliness],
    ['uniqueness', dims.uniqueness],
    ['consistency', dims.consistency],
  ];
  for (const [name, score] of entries) {
    if (score < 0.4) failed.push(name);
  }
  return failed;
}

/**
 * Assess quality dimensions of a knowledge entry (FR-N05 Enhancement).
 *
 * Evaluates atomicity, completeness, unambiguity, verifiability, timeliness
 * alongside the existing value dimensions (privacy, scenarioSpecificity, llmBlindSpot)
 * in a single LLM call.
 *
 * Returns both a QualityAssessment and a ValueAssessment for backward compatibility.
 * When LLM is unavailable, degrades to metadata-only validation with all dimensions at 0.5.
 */
export async function assessQualityDimensions(
  title: string,
  content: string,
  configDir?: string,
): Promise<{ quality: QualityAssessment; value: ValueAssessment }> {
  const truncated = content.length > 2000 ? content.slice(0, 2000) : content;
  const prompt = `${QUALITY_ASSESSMENT_PROMPT}\n\n知识标题：${title}\n知识内容：\n${truncated}`;

  try {
    const llm = getLlmProvider();
    const raw = await llm.complete(prompt);
    const result = parseQualityResponse(raw);

    if (result) {
      const overallScore = computeOverallScore(result.quality);
      const failedDimensions = identifyFailedDimensions(result.quality);

      // Apply threshold override to value assessment
      const thresholds = loadValueGateThresholds(configDir);
      const value = applyThresholdOverride(result.value, thresholds);

      const quality: QualityAssessment = {
        dimensions: result.quality,
        overallScore,
        passesGate: overallScore >= 0.6,
        failedDimensions,
      };

      return { quality, value };
    }
  } catch {
    // LLM unavailable — fall through to fallback
  }

  // Fallback: LLM unavailable or unparseable response — reject to prevent low-quality entries
  console.warn(`[KIVO ValueGate] LLM 不可用，拒绝条目 "${title}" (reason: llm_unavailable_reject)`);
  const fallbackScore = computeOverallScore(FALLBACK_QUALITY_DIMENSIONS);
  return {
    quality: {
      dimensions: { ...FALLBACK_QUALITY_DIMENSIONS },
      overallScore: fallbackScore,
      passesGate: false,
      failedDimensions: ['llm_unavailable'],
    },
    value: {
      isHighValue: false,
      category: 'common_knowledge',
      confidence: 0,
      reasoning: 'llm_unavailable_reject',
      dimensions: { privacy: 0, scenarioSpecificity: 0, llmBlindSpot: 0 },
      requiresRetry: true,
    },
  };
}
