import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../adapter/llm-provider.js';
import { Classifier } from '../pipeline/classifier.js';
import type { KnowledgeEntry, KnowledgeSource } from '../types/index.js';
import {
  buildDerivedSource,
  clampConfidence,
  extractJsonBlock,
  generateSummary,
  generateTitle,
  normalizeKnowledgeCandidates,
  uniqueTags,
} from './extraction-utils.js';

export type RulePriority = 'low' | 'medium' | 'high' | 'critical';

export interface RuleEntry {
  id: string;
  scene: string;
  directive: string;
  priority: RulePriority;
  source: KnowledgeSource;
  confidence: number;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type RuleLLMProvider = LLMProvider;

export interface RuleExtractorOptions {
  llmProvider?: RuleLLMProvider;
  classifier?: Classifier;
  minConfidence?: number;
}

interface RuleCandidate {
  scene?: string;
  directive?: string;
  priority?: string;
  confidence?: number;
  tags?: string[];
}

export interface RuleChangeEvent {
  type: 'added' | 'modified' | 'removed';
  rule: RuleEntry;
  previousRule?: RuleEntry;
}

export interface RuleConflict {
  ruleA: RuleEntry;
  ruleB: RuleEntry;
  reason: string;
}

// Heuristic fallback pattern — LLM extraction preferred for production use.
// When used independently, confidence is capped at 0.4.
const DIRECTIVE_PATTERN = /(必须|禁止|不得|不允许|应当|应该|需要|must|must not|should|should not|never|always)/i;

export class RuleExtractor {
  private readonly llmProvider?: RuleLLMProvider;
  private readonly classifier: Classifier;
  private readonly minConfidence: number;

  constructor(options: RuleExtractorOptions = {}) {
    this.llmProvider = options.llmProvider;
    this.classifier = options.classifier ?? new Classifier();
    this.minConfidence = options.minConfidence ?? 0.5;
  }

  async extract(text: string, source: KnowledgeSource): Promise<RuleEntry[]> {
    if (!text.trim()) return [];

    if (this.llmProvider) {
      const raw = await this.llmProvider.complete(buildRulePrompt(text));
      const parsed = extractJsonBlock(raw);
      const candidates = normalizeKnowledgeCandidates(parsed) as RuleCandidate[];
      return candidates
        .map((candidate, index) => this.toRuleEntry(candidate, source, index, text))
        .filter((entry): entry is RuleEntry => entry !== null);
    }

    return this.extractHeuristically(text, source);
  }

  toKnowledgeEntries(rules: RuleEntry[]): KnowledgeEntry[] {
    const entries: KnowledgeEntry[] = [];
    for (const rule of rules) {
      const now = new Date();
      entries.push({
        id: randomUUID(),
        type: 'intent',
        title: rule.scene || generateTitle(rule.directive),
        content: rule.directive,
        summary: generateSummary(rule.directive),
        source: rule.source,
        confidence: rule.confidence,
        status: 'active',
        tags: uniqueTags(['rule', rule.priority, ...rule.tags]),
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
    }
    return entries;
  }

  /**
   * Heuristic fallback extraction — LLM extraction preferred.
   * Used only when llmProvider is not configured.
   * Confidence is capped at 0.4 to reflect lower reliability vs LLM.
   */
  private extractHeuristically(text: string, source: KnowledgeSource): RuleEntry[] {
    const lines = text
      .split(/\n+/)
      .map(line => line.trim())
      .filter(Boolean);

    const rules: RuleEntry[] = [];
    for (const [index, line] of lines.entries()) {
      if (!DIRECTIVE_PATTERN.test(line)) continue;

      const scene = this.inferScene(line);
      const priority = this.inferPriority(line);
      const confidence = this.inferConfidence(line, priority);
      const now = new Date();

      rules.push({
        id: randomUUID(),
        scene,
        directive: line,
        priority,
        source: buildDerivedSource(source, line),
        confidence,
        tags: uniqueTags(['rule', priority]),
        createdAt: now,
        updatedAt: now,
      });
    }

    return rules;
  }

  private toRuleEntry(candidate: RuleCandidate, source: KnowledgeSource, index: number, text: string): RuleEntry | null {
    const directive = candidate.directive?.trim();
    if (!directive) return null;

    const priority = normalizePriority(candidate.priority, directive);
    const confidence = clampConfidence(candidate.confidence, this.inferConfidence(directive, priority));
    const scene = candidate.scene?.trim() || this.inferScene(directive);
    const now = new Date();

    return {
      id: randomUUID(),
      scene,
      directive,
      priority,
      source: buildDerivedSource(source, text.slice(Math.max(0, index * 120), Math.max(120, (index + 1) * 120))),
      confidence,
      tags: uniqueTags(candidate.tags),
      createdAt: now,
      updatedAt: now,
    };
  }

  private inferScene(text: string): string {
    const match = text.match(/^(?:在|当|如果|针对|对于)?([^，。,；;:：]{2,30})(?:时|场景|情况下)?[，。,；;:：]/);
    if (match) return match[1].trim();

    const clean = text.replace(DIRECTIVE_PATTERN, '').trim();
    return clean.split(/[，。,；;:：]/)[0]?.trim() || 'general';
  }

  private inferPriority(text: string): RulePriority {
    return normalizePriority(undefined, text);
  }

  /**
   * Heuristic fallback: infer confidence from text pattern.
   * When used without LLM, confidence is capped at 0.4 to reflect lower reliability.
   * LLM extraction preferred — this is a heuristic fallback path.
   */
  private inferConfidence(text: string, priority: RulePriority): number {
    // Heuristic fallback confidence capped at 0.4 (LLM extraction preferred)
    const base = DIRECTIVE_PATTERN.test(text) ? 0.35 : 0.2;
    if (priority === 'critical') return Math.min(0.4, base + 0.05);
    if (priority === 'high') return Math.min(0.4, base + 0.03);
    return base;
  }

  /**
   * FR-A03 AC2: Detect changes between old and new rule sets.
   * Compares by scene+directive to identify added, modified, and removed rules.
   */
  detectChanges(oldRules: RuleEntry[], newRules: RuleEntry[]): RuleChangeEvent[] {
    const events: RuleChangeEvent[] = [];
    const oldMap = new Map(oldRules.map(r => [normalizeRuleKey(r), r]));
    const newMap = new Map(newRules.map(r => [normalizeRuleKey(r), r]));

    for (const [key, newRule] of newMap) {
      const oldRule = oldMap.get(key);
      if (!oldRule) {
        events.push({ type: 'added', rule: newRule });
      } else if (oldRule.directive !== newRule.directive || oldRule.priority !== newRule.priority) {
        events.push({ type: 'modified', rule: newRule, previousRule: oldRule });
      }
    }

    for (const [key, oldRule] of oldMap) {
      if (!newMap.has(key)) {
        events.push({ type: 'removed', rule: oldRule });
      }
    }

    return events;
  }

  /**
   * FR-A03 AC3: Detect conflicts and override relationships between rules.
   * Two rules conflict if they apply to the same scene but have contradictory directives.
   */
  detectConflicts(rules: RuleEntry[]): RuleConflict[] {
    const conflicts: RuleConflict[] = [];
    const byScene = new Map<string, RuleEntry[]>();

    for (const rule of rules) {
      const scene = rule.scene.toLowerCase().trim();
      const existing = byScene.get(scene) ?? [];
      existing.push(rule);
      byScene.set(scene, existing);
    }

    for (const [, sceneRules] of byScene) {
      if (sceneRules.length < 2) continue;
      for (let i = 0; i < sceneRules.length; i++) {
        for (let j = i + 1; j < sceneRules.length; j++) {
          const a = sceneRules[i];
          const b = sceneRules[j];
          if (areContradictory(a.directive, b.directive)) {
            conflicts.push({
              ruleA: a,
              ruleB: b,
              reason: `Contradictory directives in scene "${a.scene}"`,
            });
          }
        }
      }
    }

    return conflicts;
  }
}

function buildRulePrompt(text: string): string {
  return [
    'Extract executable rules from the text.',
    'Return JSON only.',
    'Schema: [{"scene":"string","directive":"string","priority":"low|medium|high|critical","confidence":0.0,"tags":["string"]}]',
    'Only keep directive statements. Ignore explanation sentences.',
    'Text:',
    text,
  ].join('\n\n');
}

function normalizePriority(priority: string | undefined, directive: string): RulePriority {
  const normalized = `${priority ?? ''} ${directive}`.toLowerCase();

  if (/(critical|最高|绝对|零容忍|must not|禁止|不得|不允许|never)/u.test(normalized)) {
    return 'critical';
  }

  if (/(high|必须|必须立即|must|required|强制)/u.test(normalized)) {
    return 'high';
  }

  if (/(low|可选|建议|optional)/u.test(normalized)) {
    return 'low';
  }

  return 'medium';
}

function normalizeRuleKey(rule: RuleEntry): string {
  return `${rule.scene.toLowerCase().trim()}::${rule.directive.slice(0, 60).toLowerCase().trim()}`;
}

const PROHIBITION_PATTERN = /(禁止|不得|不允许|must not|never|cannot)/i;
const OBLIGATION_PATTERN = /(必须|应当|must|should|always|需要)/i;

function areContradictory(directiveA: string, directiveB: string): boolean {
  const aProhibits = PROHIBITION_PATTERN.test(directiveA);
  const bProhibits = PROHIBITION_PATTERN.test(directiveB);
  const aObligates = OBLIGATION_PATTERN.test(directiveA);
  const bObligates = OBLIGATION_PATTERN.test(directiveB);

  // One prohibits what the other obligates
  if ((aProhibits && bObligates) || (aObligates && bProhibits)) {
    return true;
  }

  return false;
}
