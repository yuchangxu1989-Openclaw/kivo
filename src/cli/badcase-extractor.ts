/**
 * Badcase Extractor (FR-N02)
 *
 * Parses badcase files and uses LLM to extract structured intent knowledge.
 * Supports three badcase source types:
 *   - user_correction: user explicitly corrected agent behavior
 *   - audit_finding: audit discovered a deviation
 *   - verification_failure: automated verification caught a failure
 *
 * AC coverage:
 *   AC1: Three source types identified and tagged
 *   AC2: LLM semantic extraction (scenario → trigger → expected → anti-pattern)
 *   AC4: Auto-annotates source type and source date
 *   AC7: All semantic understanding via LLM, zero regex/template
 */

import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import { readFileSync } from 'node:fs';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';
import { resolveLlmConfig } from './resolve-llm-config.js';

// LLM provider singleton for source type classification (lazy-initialized)
let _classificationLlm: OpenAILLMProvider | null = null;

function getClassificationLlm(): OpenAILLMProvider {
  if (!_classificationLlm) {
    const llmConfig = resolveLlmConfig();
    if ('error' in llmConfig) {
      throw new Error(llmConfig.error);
    }
    _classificationLlm = new OpenAILLMProvider({
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl,
      model: llmConfig.model,
      timeoutMs: 30_000,
    });
  }
  return _classificationLlm;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type BadcaseSourceType = 'user_correction' | 'audit_finding' | 'verification_failure';

export interface BadcaseEntry {
  /** Raw text content of the badcase */
  text: string;
  /** Source type classification */
  sourceType: BadcaseSourceType;
  /** Date the badcase was recorded */
  sourceDate: string;
  /** Optional file path origin */
  filePath?: string;
}

export interface ExtractedIntent {
  /** Short title */
  title: string;
  /** Full intent description */
  content: string;
  /** Scenario where this intent applies */
  scenario: string;
  /** What triggers this intent */
  triggerCondition: string;
  /** Expected behavior */
  expectedBehavior: string;
  /** Anti-pattern to avoid */
  antiPattern: string;
  /** Confidence score 0-1 */
  confidence: number;
  /** Tags for categorization */
  tags: string[];
  /** Similar sentences for intent matching */
  similarSentences: string[];
  /** Source type from the badcase */
  sourceType: BadcaseSourceType;
  /** Date from the badcase */
  sourceDate: string;
}

// ── Badcase file parser ──────────────────────────────────────────────────────

/**
 * Parse a badcase file into structured entries.
 * Supports markdown files with sections separated by `---` or `## `.
 * Each section is treated as one badcase entry.
 */
export async function parseBadcaseFile(filePath: string): Promise<BadcaseEntry[]> {
  const raw = readFileSync(filePath, 'utf-8');
  return parseBadcaseText(raw, filePath);
}

/**
 * Parse raw badcase text into structured entries.
 * Uses LLM for semantic source type classification.
 */
export async function parseBadcaseText(text: string, filePath?: string): Promise<BadcaseEntry[]> {
  // Split by markdown section headers or horizontal rules
  const sections = text
    .split(/(?:^|\n)(?:---+|\*\*\*+|___+)\s*\n|(?:^|\n)##\s+/m)
    .map(s => s.trim())
    .filter(s => s.length > 20); // skip trivially short sections

  if (sections.length === 0 && text.trim().length > 20) {
    // Treat entire text as one badcase
    sections.push(text.trim());
  }

  const now = new Date().toISOString().slice(0, 10);

  const entries: BadcaseEntry[] = [];
  for (const section of sections) {
    const sourceType = await detectSourceTypeLlm(section);
    const sourceDate = extractDate(section) ?? now;
    entries.push({
      text: section,
      sourceType,
      sourceDate,
      filePath,
    });
  }

  return entries;
}

/**
 * Detect badcase source type from text content using LLM semantic classification.
 * Falls back to 'user_correction' if LLM is unavailable.
 */
async function detectSourceTypeLlm(text: string): Promise<BadcaseSourceType> {
  const prompt = `你是一个分类引擎。判断以下 badcase（错误案例）文本属于哪种来源类型。

三种类型：
- user_correction：用户主动纠偏、用户指出错误、用户要求修改行为
- audit_finding：代码审计、质量审查、安全审计中发现的问题
- verification_failure：自动化测试失败、验证不通过、CI/CD 失败

只返回类型名称，不要解释。如果无法判断，返回 user_correction。

文本：
${text.slice(0, 2000)}`;

  try {
    const llm = getClassificationLlm();
    const raw = (await llm.complete(prompt)).trim().toLowerCase();
    if (raw.includes('audit_finding')) return 'audit_finding';
    if (raw.includes('verification_failure')) return 'verification_failure';
    if (raw.includes('user_correction')) return 'user_correction';
    return 'user_correction';
  } catch {
    // LLM unavailable — fall back to default
    return 'user_correction';
  }
}

/**
 * @deprecated Use detectSourceTypeLlm for semantic classification.
 * Kept only as a sync fallback for non-async contexts.
 */
function detectSourceTypeSync(text: string): BadcaseSourceType {
  const lower = text.toLowerCase();
  if (lower.includes('用户纠偏') || lower.includes('user_correction') || lower.includes('纠偏') || lower.includes('correction')) {
    return 'user_correction';
  }
  if (lower.includes('审计') || lower.includes('audit') || lower.includes('review') || lower.includes('audit_finding')) {
    return 'audit_finding';
  }
  if (lower.includes('验证失败') || lower.includes('verification') || lower.includes('test fail') || lower.includes('verification_failure')) {
    return 'verification_failure';
  }
  return 'user_correction';
}

/**
 * Extract a date from text if present (YYYY-MM-DD format).
 */
function extractDate(text: string): string | undefined {
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : undefined;
}

// ── LLM Intent Extraction ────────────────────────────────────────────────────

function buildExtractionPrompt(entries: BadcaseEntry[]): string {
  const combined = entries
    .map((e, i) => `[Badcase ${i + 1}] (来源: ${e.sourceType}, 日期: ${e.sourceDate})\n${e.text}`)
    .join('\n\n---\n\n');

  return `你是一个知识提取引擎。从以下 badcase（错误案例/纠偏记录）中提取结构化的意图知识。

每条 badcase 描述了一个"做错了"或"应该怎么做"的场景。你需要提取：
1. scenario（场景）：在什么情况下会触发这个问题
2. trigger_condition（触发条件）：具体什么操作/输入/状态触发了问题
3. expected_behavior（预期行为）：正确的做法是什么
4. anti_pattern（反模式）：错误的做法是什么（即 badcase 中描述的问题）
5. title（标题）：简短描述这条意图，最长 50 个字符
6. content（内容）：完整的意图描述，包含上述四个维度
7. confidence（置信度）：0-1，反映这条知识的确定性
8. tags（标签）：相关标签数组
9. similar_sentences（相似句）：5~10 条用户可能说出的、触发这条意图的自然语言句子

输出纯 JSON 数组，每条格式：
{
  "title": "简短标题（≤50字符）",
  "content": "完整意图描述",
  "scenario": "场景描述",
  "trigger_condition": "触发条件",
  "expected_behavior": "预期行为",
  "anti_pattern": "反模式",
  "confidence": 0.0-1.0,
  "tags": ["标签"],
  "similar_sentences": ["句子1", "句子2", ...]
}

要求：
- 中文输入产出中文知识
- 每条 badcase 至少提取 1 条意图（除非内容完全无价值）
- title 必须是简短标题，最长 50 个字符；不要把整段 content 原样复制进 title
- 不要包含 markdown 代码块标记
- 如果没有可提取的知识，返回空数组 []

Badcase 内容：
${combined}`;
}

function parseLlmIntentResponse(raw: string): Array<{
  title: string;
  content: string;
  scenario: string;
  trigger_condition: string;
  expected_behavior: string;
  anti_pattern: string;
  confidence: number;
  tags: string[];
  similar_sentences: string[];
}> {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).content === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Extract structured intents from badcase entries using LLM.
 * AC2 + AC7: All semantic understanding via LLM.
 */
export async function extractIntentsFromBadcases(
  entries: BadcaseEntry[],
): Promise<ExtractedIntent[]> {
  if (entries.length === 0) return [];

  const llmConfig = resolveLlmConfig();
  if ('error' in llmConfig) {
    throw new Error(llmConfig.error);
  }

  const llm = new OpenAILLMProvider({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    timeoutMs: 120_000,
  });

  const prompt = buildExtractionPrompt(entries);
  const rawResponse = await llm.complete(prompt);
  const items = parseLlmIntentResponse(rawResponse);

  // Map LLM output back to ExtractedIntent, pairing with source metadata
  const results: ExtractedIntent[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // Associate with the corresponding badcase entry (or the last one if more items than entries)
    const sourceEntry = entries[Math.min(i, entries.length - 1)];

    const similarSentences = Array.isArray(item.similar_sentences)
      ? item.similar_sentences
          .filter((s: unknown) => typeof s === 'string' && (s as string).trim().length > 0)
          .map((s: string) => s.length > 200 ? s.slice(0, 200) : s)
          .slice(0, 15)
      : [];

    results.push({
      title: shortenKnowledgeTitle(item.title, item.content),
      content: item.content,
      scenario: item.scenario || '',
      triggerCondition: item.trigger_condition || '',
      expectedBehavior: item.expected_behavior || '',
      antiPattern: item.anti_pattern || '',
      confidence: typeof item.confidence === 'number' ? Math.min(1, Math.max(0, item.confidence)) : 0.7,
      tags: Array.isArray(item.tags) ? item.tags : [],
      similarSentences,
      sourceType: sourceEntry.sourceType,
      sourceDate: sourceEntry.sourceDate,
    });
  }

  return results;
}
