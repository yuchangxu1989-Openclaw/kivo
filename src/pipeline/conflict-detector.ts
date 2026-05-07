/**
 * ConflictDetector — Write-time conflict detection for ingest pipeline (FR-C01).
 *
 * Before a new entry is written to the DB, this module:
 * 1. Embeds the new entry content via BGE
 * 2. Retrieves top-K semantically similar existing entries (cosine > 0.75)
 * 3. Uses LLM to classify the relationship (equivalent/complementary/contradictory/unrelated)
 * 4. Decides whether to block the write based on the relationship
 *
 * Degraded mode (LLM unavailable): only blocks on cosine > 0.90 (assumed equivalent).
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { cosineSimilarity } from '../utils/math.js';
import { resolveLlmConfig } from '../cli/resolve-llm-config.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConflictResult {
  relation: 'equivalent' | 'complementary' | 'contradictory' | 'unrelated';
  confidence: number;
  existingEntryId: string;
  explanation: string;
}

export interface ConflictDetectionResult {
  shouldBlock: boolean;
  blockReason?: string;
  conflicts: ConflictResult[];
  suggestedAction?: 'merge' | 'resolve_contradiction' | 'link' | 'proceed';
}

export interface ConflictDetectorOptions {
  /** Minimum cosine similarity to consider as candidate (default 0.75) */
  similarityThreshold?: number;
  /** Maximum number of similar entries to evaluate (default 5) */
  topK?: number;
  /** Cosine threshold for degraded-mode equivalent detection (default 0.90) */
  degradedEquivalentThreshold?: number;
}

interface EntryRow {
  id: string;
  title: string;
  content: string;
  embedding: Buffer;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SIMILARITY_THRESHOLD = 0.75;
const DEFAULT_TOP_K = 5;
const DEFAULT_DEGRADED_THRESHOLD = 0.90;

const CONFLICT_DETECTION_PROMPT = `你是知识库质量管理专家。判断以下两条知识的关系：

条目A（新）：{titleA} - {contentA}
条目B（已有）：{titleB} - {contentB}

关系类型：
- equivalent：语义完全等价，说的是同一件事
- complementary：互补，从不同角度描述同一主题
- contradictory：矛盾，对同一问题给出冲突的结论
- unrelated：无关

输出纯 JSON：{"relation": "...", "confidence": 0.0-1.0, "explanation": "..."}
不要包含 markdown 代码块标记。`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function bufferToVector(buf: Buffer): number[] {
  const float32 = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / 4,
  );
  return Array.from(float32);
}

function buildConflictPrompt(
  newTitle: string,
  newContent: string,
  existingTitle: string,
  existingContent: string,
): string {
  const truncNew = newContent.length > 1000 ? newContent.slice(0, 1000) : newContent;
  const truncExisting = existingContent.length > 1000 ? existingContent.slice(0, 1000) : existingContent;

  return CONFLICT_DETECTION_PROMPT
    .replace('{titleA}', newTitle)
    .replace('{contentA}', truncNew)
    .replace('{titleB}', existingTitle)
    .replace('{contentB}', truncExisting);
}

interface LlmRelationResult {
  relation: 'equivalent' | 'complementary' | 'contradictory' | 'unrelated';
  confidence: number;
  explanation: string;
}

function parseLlmRelationResponse(raw: string): LlmRelationResult | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    const validRelations = ['equivalent', 'complementary', 'contradictory', 'unrelated'];
    const relation = validRelations.includes(parsed.relation) ? parsed.relation : 'unrelated';
    const confidence = typeof parsed.confidence === 'number'
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.5;
    const explanation = typeof parsed.explanation === 'string' ? parsed.explanation : '';

    return { relation, confidence, explanation };
  } catch {
    return null;
  }
}

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Retrieve top-K semantically similar entries from the database.
 */
function findSimilarEntries(
  newVector: number[],
  dbPath: string,
  threshold: number,
  topK: number,
): Array<EntryRow & { similarity: number }> {
  if (!existsSync(dbPath)) return [];

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(
      `SELECT id, title, content, embedding FROM entries
       WHERE embedding IS NOT NULL AND status = 'active'`,
    ).all() as EntryRow[];

    const scored: Array<EntryRow & { similarity: number }> = [];

    for (const row of rows) {
      const vec = bufferToVector(row.embedding);
      const score = cosineSimilarity(newVector, vec);
      if (score > threshold) {
        scored.push({ ...row, similarity: score });
      }
    }

    // Sort descending by similarity, take top-K
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  } finally {
    db.close();
  }
}

/**
 * Detect conflicts between a new entry and existing entries in the knowledge base.
 *
 * @param newEntry - The entry about to be ingested (needs title, content)
 * @param newVector - BGE embedding vector of the new entry's content
 * @param dbPath - Path to the SQLite database
 * @param options - Detection options (thresholds, topK)
 */
export async function detectConflicts(
  newEntry: { title: string; content: string },
  newVector: number[],
  dbPath: string,
  options: ConflictDetectorOptions = {},
): Promise<ConflictDetectionResult> {
  const {
    similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
    topK = DEFAULT_TOP_K,
    degradedEquivalentThreshold = DEFAULT_DEGRADED_THRESHOLD,
  } = options;

  // Step 1: Find similar entries
  const similar = findSimilarEntries(newVector, dbPath, similarityThreshold, topK);

  if (similar.length === 0) {
    return { shouldBlock: false, conflicts: [], suggestedAction: 'proceed' };
  }

  // Step 2: Try to get LLM for relationship classification
  const llmConfig = resolveLlmConfig();
  const llmAvailable = !('error' in llmConfig);

  let llmProvider: OpenAILLMProvider | null = null;
  if (llmAvailable) {
    llmProvider = new OpenAILLMProvider({
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl,
      model: llmConfig.model,
      timeoutMs: 30_000,
    });
  }

  const conflicts: ConflictResult[] = [];

  // Step 3: Classify each similar entry
  for (const entry of similar) {
    if (llmProvider) {
      // LLM-based classification
      const prompt = buildConflictPrompt(
        newEntry.title,
        newEntry.content,
        entry.title,
        entry.content,
      );

      try {
        const raw = await llmProvider.complete(prompt);
        const result = parseLlmRelationResponse(raw);

        if (result) {
          conflicts.push({
            relation: result.relation,
            confidence: result.confidence,
            existingEntryId: entry.id,
            explanation: result.explanation,
          });
        } else {
          // Unparseable LLM response — fall back to similarity-based heuristic
          conflicts.push(degradedClassification(entry));
        }
      } catch {
        // LLM call failed — use degraded mode for this entry
        conflicts.push(degradedClassification(entry));
      }
    } else {
      // Degraded mode: no LLM available
      conflicts.push(degradedClassification(entry));
    }
  }

  // Step 4: Determine overall action
  return determineAction(conflicts);

  // ── Inner helpers ──

  function degradedClassification(entry: EntryRow & { similarity: number }): ConflictResult {
    if (entry.similarity > degradedEquivalentThreshold) {
      return {
        relation: 'equivalent',
        confidence: entry.similarity,
        existingEntryId: entry.id,
        explanation: `高语义相似度 (${(entry.similarity * 100).toFixed(1)}%)，降级模式判定为等价`,
      };
    }
    // Below degraded threshold but above similarity threshold — mark as unrelated in degraded mode
    return {
      relation: 'unrelated',
      confidence: 0.3,
      existingEntryId: entry.id,
      explanation: `降级模式：相似度 ${(entry.similarity * 100).toFixed(1)}% 未达等价阈值，跳过`,
    };
  }
}

/**
 * Determine the overall action based on classified conflicts.
 * Priority: equivalent > contradictory > complementary > unrelated
 */
function determineAction(conflicts: ConflictResult[]): ConflictDetectionResult {
  const equivalent = conflicts.filter(c => c.relation === 'equivalent');
  const contradictory = conflicts.filter(c => c.relation === 'contradictory');
  const complementary = conflicts.filter(c => c.relation === 'complementary');

  if (equivalent.length > 0) {
    return {
      shouldBlock: true,
      blockReason: `与已有条目语义等价: ${equivalent[0].existingEntryId.slice(0, 8)} (${equivalent[0].explanation})`,
      conflicts,
      suggestedAction: 'merge',
    };
  }

  if (contradictory.length > 0) {
    return {
      shouldBlock: true,
      blockReason: `与已有条目存在矛盾: ${contradictory[0].existingEntryId.slice(0, 8)} (${contradictory[0].explanation})`,
      conflicts,
      suggestedAction: 'resolve_contradiction',
    };
  }

  if (complementary.length > 0) {
    return {
      shouldBlock: false,
      conflicts,
      suggestedAction: 'link',
    };
  }

  return {
    shouldBlock: false,
    conflicts,
    suggestedAction: 'proceed',
  };
}
