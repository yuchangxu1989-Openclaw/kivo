/**
 * Shared ingest core — BGE + LLM semantic extraction pipeline.
 *
 * Used by both `kivo ingest` and `kivo cron` to avoid code duplication.
 * Handles: chunk splitting, BGE embedding, vector dedup, LLM extraction,
 * entry storage, and proper resource cleanup (including embedder.close()).
 */

import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import { readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import Database from 'better-sqlite3';
import { KnowledgeRepository } from '../repository/index.js';
import { SQLiteProvider } from '../repository/index.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';
import { detectConflicts } from '../pipeline/conflict-detector.js';
import { assessQualityDimensions } from '../pipeline/value-gate.js';
import type { KnowledgeSource, KnowledgeEntry, KnowledgeType } from '../types/index.js';

export interface IngestCoreOptions {
  /** Base directory for relative path computation */
  dir: string;
  /** Database file path */
  dbPath: string;
  /** Markdown files to process */
  mdFiles: string[];
  /** Output JSON format */
  json?: boolean;
  /** Skip FR-N05 quality gate */
  noQualityGate?: boolean;
}

export interface IngestCoreResult {
  extracted: number;
  deduped: number;
  skipped: number;
  files: number;
  details: string[];
}

const VALID_KNOWLEDGE_TYPES = new Set(['intent', 'methodology', 'fact', 'experience', 'decision', 'meta']);

const TITLE_HARD_LIMIT = 20;

/**
 * FR-N05 AC8: Compress title to ≤ 20 chars.
 * Rules (no LLM):
 *  1. Remove parenthetical content: (...) / （...）
 *  2. Remove content after colon if remainder is mostly non-CJK
 *  3. Truncate to 19 chars + '…' if still over limit
 */
function compressTitleTo20(title: string): string {
  if (title.length <= TITLE_HARD_LIMIT) return title;

  let t = title;

  // Step 1: Remove parenthetical content
  t = t.replace(/[（(][^)）]*[)）]/g, '').trim();
  if (t.length <= TITLE_HARD_LIMIT && t.length > 0) return t;

  // Step 2: If there's a colon and content after it is mostly non-CJK, keep only before colon
  const colonMatch = t.match(/^(.+?)[：:](.*)/s);
  if (colonMatch) {
    const before = colonMatch[1].trim();
    const after = colonMatch[2].trim();
    // If after-colon part is mostly ASCII/symbols (>60%), drop it
    const nonCjk = after.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, '').length;
    if (after.length > 0 && nonCjk / after.length > 0.6) {
      t = before;
      if (t.length <= TITLE_HARD_LIMIT && t.length > 0) return t;
    }
  }

  // Step 3: Hard truncate
  if (t.length > TITLE_HARD_LIMIT) {
    t = t.slice(0, TITLE_HARD_LIMIT - 1) + '…';
  }
  return t || title.slice(0, TITLE_HARD_LIMIT - 1) + '…';
}

function validateKnowledgeType(type: string): KnowledgeType {
  const normalized = (type ?? '').toLowerCase().trim();
  if (VALID_KNOWLEDGE_TYPES.has(normalized)) return normalized as KnowledgeType;
  return 'fact';
}

function buildLlmExtractionPrompt(chunkContent: string, filePath: string): string {
  return `从以下文本中提取有价值的知识条目。每条知识包含：
- title: 简短标题（≤50字符）
- content: 知识内容
- type: intent/methodology/fact/experience/decision/meta 之一
- tags: 相关标签数组
- similar_sentences: 仅当 type 为 "intent" 时必填，包含 5~10 条用户可能说出的、表达同一意图的自然语言句子。非 intent 类型不需要这个字段。

重点提取：
- intent: 用户偏好、行为模式、「当用户说X时实际想要Y」
- decision: 明确的决策和选择
- methodology: 工作方法和流程
- experience: 经验教训和踩坑记录

similar_sentences 示例（仅限 intent 类型）：
意图“用户偏好中文回复”的 similar_sentences: ["用中文回答我", "请说中文", "我想要中文的回复", "能不能用中文", "switch to Chinese"]

输出纯 JSON 数组，不要包含 markdown 代码块标记。中文输入必须产出中文知识。
标题规则：title 必须是简短标题，最长 50 个字符；不要把整段 content 原样复制进 title。
如果文本中没有可提取的知识，返回空数组 []。

文件路径: ${filePath}

文本内容:
${chunkContent}`;
}

function parseLlmResponse(raw: string): Array<{ title: string; content: string; type: string; tags: string[]; similar_sentences?: string[] }> {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (item: unknown) =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as Record<string, unknown>).content === 'string',
        )
        .map((item: Record<string, unknown>) => {
          // Validate and sanitize similar_sentences
          if (Array.isArray(item.similar_sentences)) {
            item.similar_sentences = (item.similar_sentences as unknown[])
              .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
              .map((s: string) => s.length > 200 ? s.slice(0, 200) : s)
              .slice(0, 15);
          }
          return item as { title: string; content: string; type: string; tags: string[]; similar_sentences?: string[] };
        });
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Core ingest pipeline shared by ingest and cron commands.
 *
 * Handles BGE embedding, vector dedup, LLM extraction, entry storage,
 * and proper cleanup of all resources (including embedder.close()).
 */
export async function runIngestCore(options: IngestCoreOptions): Promise<IngestCoreResult> {
  const { dir, dbPath, mdFiles, noQualityGate = false } = options;

  // Resolve API config
  const { resolveLlmConfig } = await import('./resolve-llm-config.js');
  const llmConfig = resolveLlmConfig();
  if ('error' in llmConfig) {
    throw new Error(llmConfig.error);
  }
  const { apiKey, baseUrl, model: llmModel } = llmConfig;

  // Initialize BGE embedder
  const { BgeEmbedder } = await import('../extraction/bge-embedder.js');
  if (!BgeEmbedder.isAvailable()) {
    throw new Error('BGE embedder not available. Install: pip install sentence-transformers');
  }
  const embedder = new BgeEmbedder();
  console.log('BGE embedder ready');

  // Initialize vector store
  const { VectorStore } = await import('../search/vector-store.js');
  const vectorStore = new VectorStore({ dbPath });

  // Initialize LLM provider
  console.log(`LLM: model=${llmModel} baseUrl=${baseUrl}`);
  const llmProvider = new OpenAILLMProvider({ apiKey, baseUrl, model: llmModel });

  // Chunk strategy
  const { ChunkStrategy } = await import('../extraction/chunk-strategy.js');
  const chunker = new ChunkStrategy({ maxTokens: 1024 });
  const { MarkdownParser } = await import('../extraction/document-parser.js');
  const parser = new MarkdownParser();

  const sqliteProvider = new SQLiteProvider({ dbPath, configDir: dir });
  const repository = new KnowledgeRepository(sqliteProvider);

  const details: string[] = [];
  let totalExtracted = 0;
  let totalSkipped = 0;
  let totalDeduped = 0;
  let consecutive403 = 0;
  const MAX_CONSECUTIVE_403 = 3;

  try {
    for (const filePath of mdFiles) {
      const content = readFileSync(filePath, 'utf-8');
      if (content.trim().length < 30) continue;

      const relPath = relative(dir, filePath) || basename(filePath);
      const source: KnowledgeSource = {
        type: 'document',
        reference: `file://${relPath}`,
        timestamp: new Date(),
      };

      const sections = parser.parse(content, source);
      const chunks = chunker.chunkSectionsByTokenBudget(sections);

      let fileExtracted = 0;
      let chunkIndex = 0;

      for (const chunk of chunks) {
        if (chunk.content.trim().length < 30) continue;
        chunkIndex++;
        console.log(`Processing chunk ${chunkIndex}/${chunks.length} from file ${relPath}...`);

        // Step 1: BGE embed the chunk
        let chunkVector: number[];
        try {
          chunkVector = await embedder.embed(chunk.content);
        } catch (err) {
          console.error(`  ✗ BGE embedding failed for chunk ${chunkIndex}: ${err instanceof Error ? err.message : String(err)}`);
          totalSkipped++;
          continue;
        }

        // Step 2: Vector dedup — skip if >0.95 similarity to existing
        if (vectorStore.isDuplicate(chunkVector, 0.95)) {
          totalDeduped++;
          continue;
        }

        // Step 3: LLM semantic extraction
        let extracted: Array<{ title: string; content: string; type: string; tags: string[]; similar_sentences?: string[] }>;
        try {
          const rawResponse = await llmProvider.complete(
            buildLlmExtractionPrompt(chunk.content, relPath),
          );
          extracted = parseLlmResponse(rawResponse);
          consecutive403 = 0;
          console.log(`  LLM extracted ${extracted.length} entries from chunk ${chunkIndex}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`  ✗ LLM extraction failed for chunk ${chunkIndex}: ${errMsg}`);
          totalSkipped++;

          // Early exit on consecutive 403 errors
          if (errMsg.includes('403')) {
            consecutive403++;
            if (consecutive403 >= MAX_CONSECUTIVE_403) {
              throw new Error(
                `Aborting: ${MAX_CONSECUTIVE_403} consecutive 403 errors. Check your API key and provider configuration.`,
              );
            }
          }
          continue;
        }

        // Step 4: Store each extracted entry + embedding
        for (const item of extracted) {
          if (!item.content || item.content.trim().length < 20) {
            totalSkipped++;
            continue;
          }

          const { randomUUID } = await import('node:crypto');
          const entryId = randomUUID();
          const now = new Date();
          const knowledgeType = validateKnowledgeType(item.type);

          const entry: KnowledgeEntry = {
            id: entryId,
            type: knowledgeType,
            title: compressTitleTo20(shortenKnowledgeTitle(item.title, item.content)),
            content: item.content,
            summary: item.content.slice(0, 120),
            source,
            confidence: 0.8,
            status: 'active',
            tags: Array.isArray(item.tags) ? item.tags : [],
            similarSentences: knowledgeType === 'intent' && Array.isArray(item.similar_sentences) && item.similar_sentences.length > 0
              ? item.similar_sentences.filter((s: unknown) => typeof s === 'string')
              : undefined,
            createdAt: now,
            updatedAt: now,
            version: 1,
          };

          // FR-N05 Enhancement: Metadata validation — enforce required fields
          if (!entry.source || !entry.source.reference) {
            entry.source = {
              ...entry.source,
              type: entry.source?.type ?? 'document',
              reference: 'auto-extracted',
              timestamp: entry.source?.timestamp ?? now,
            };
          }
          if (!entry.type) {
            entry.type = 'fact';
          }

          // FR-N05 Enhancement: Multi-dimensional quality scoring
          try {
            const { quality } = await assessQualityDimensions(entry.title, entry.content, dir);
            // Write overallScore to confidence field (backward compatible)
            entry.confidence = quality.overallScore;
            // Write dimensions JSON to metadata field
            entry.metadata = entry.metadata ?? {};
            entry.metadata.domainData = entry.metadata.domainData ?? {};
            entry.metadata.domainData.qualityDimensions = quality.dimensions;
            entry.metadata.domainData.qualityOverallScore = quality.overallScore;
            entry.metadata.domainData.qualityPassesGate = quality.passesGate;
            entry.metadata.domainData.qualityFailedDimensions = quality.failedDimensions;
          } catch {
            // LLM unavailable — degrade to metadata validation only, dimensions all 0.5
            entry.confidence = 0.5;
            entry.metadata = entry.metadata ?? {};
            entry.metadata.domainData = entry.metadata.domainData ?? {};
            entry.metadata.domainData.qualityDimensions = {
              atomicity: 0.5,
              completeness: 0.5,
              unambiguity: 0.5,
              verifiability: 0.5,
              timeliness: 0.5,
              uniqueness: 1.0,
              consistency: 1.0,
            };
            entry.metadata.domainData.qualityOverallScore = 0.5;
            entry.metadata.domainData.qualityPassesGate = false;
            entry.metadata.domainData.qualityFailedDimensions = [];
          }

          // FR-C01: Write-time conflict detection
          let entryVector: number[];
          try {
            entryVector = await embedder.embed(entry.content);
          } catch {
            // Embedding failed — skip conflict detection, proceed to save
            entryVector = [];
          }

          if (entryVector.length > 0) {
            const conflictResult = await detectConflicts(
              { title: entry.title, content: entry.content },
              entryVector,
              dbPath,
            );

            if (conflictResult.shouldBlock) {
              console.warn(
                `  ⚠ Conflict detected for "${entry.title}": ${conflictResult.blockReason ?? conflictResult.suggestedAction} — skipping`,
              );
              totalSkipped++;
              continue;
            }

            // Record complementary relationships in metadata
            if (conflictResult.suggestedAction === 'link') {
              const relatedIds = conflictResult.conflicts
                .filter(c => c.relation === 'complementary')
                .map(c => c.existingEntryId);
              if (relatedIds.length > 0) {
                entry.metadata = entry.metadata ?? {};
                entry.metadata.domainData = entry.metadata.domainData ?? {};
                entry.metadata.domainData.related_entries = relatedIds;
              }
            }
          }

          // FR-N05 统一门禁在 repository.save 中执行；这里不再做局部门禁
          const saved = await repository.save(entry, { skipQualityGate: noQualityGate });
          if (!saved) {
            totalSkipped++;
            continue;
          }

          fileExtracted++;
          totalExtracted++;
        }
      }

      if (fileExtracted > 0) {
        details.push(`  ${relPath}: ${fileExtracted} entries (LLM)`);
      }
    }
  } finally {
    // Always clean up resources — fixes P0 (embedder.close() leak)
    await embedder.close();
    vectorStore.close();
    await repository.close();
  }

  // Rebuild FTS index
  const db = new Database(dbPath);
  try {
    db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`);
  } catch { /* non-fatal */ }
  db.close();

  return { extracted: totalExtracted, deduped: totalDeduped, skipped: totalSkipped, files: mdFiles.length, details };
}
