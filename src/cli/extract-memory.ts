/**
 * CLI: kivo extract-sessions --source memory
 *
 * Extracts knowledge from workspace memory/*.md files via:
 * 1. Scan memory directory for .md files
 * 2. Split each file by ## headings into chunks
 * 3. Hash-based dedup: skip files whose content hasn't changed
 * 4. LLM extraction → structured knowledge with multi-dimensional tags
 * 5. Write to KIVO DB with source='memory'
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { resolveLlmConfig } from './resolve-llm-config.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';
import { BgeEmbedder } from '../extraction/bge-embedder.js';
import { KnowledgeRepository, SQLiteProvider } from '../repository/index.js';
import { buildBehavioralChangeTestSection, loadDedupThreshold } from '../standards/index.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import {
  parseLlmResponse,
  estimateTokens,
  cosineSimilarity,
  validateNature,
  validateFunction,
  NATURE_TO_TYPE,
} from './session-knowledge-llm.js';
import type { ExtractedItem } from './session-knowledge-llm.js';
import type { KnowledgeEntry, KnowledgeType, KnowledgeNature, KnowledgeFunction } from '../types/index.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExtractMemoryOptions {
  dryRun?: boolean;
  limit?: number;
  memoryDir?: string;
  noQualityGate?: boolean;
}

export interface MemoryExtractResult {
  filesScanned: number;
  filesSkipped: number;
  chunksProcessed: number;
  knowledgeExtracted: number;
  knowledgeWritten: number;
  tokenEstimate: number;
  errors: string[];
}

interface MemoryChunk {
  file: string;
  heading: string;
  content: string;
}

// ── Memory file parsing ──────────────────────────────────────────────────────

/**
 * Split a markdown file into chunks by ## headings.
 * Each chunk includes the heading and all content until the next ## heading.
 */
function splitByHeadings(content: string, filePath: string): MemoryChunk[] {
  const lines = content.split('\n');
  const chunks: MemoryChunk[] = [];
  let currentHeading = '';
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // Save previous chunk if it has content
      if (currentLines.length > 0 && currentLines.some(l => l.trim().length > 0)) {
        chunks.push({
          file: filePath,
          heading: currentHeading || basename(filePath),
          content: currentLines.join('\n').trim(),
        });
      }
      currentHeading = line.slice(3).trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Save last chunk
  if (currentLines.length > 0 && currentLines.some(l => l.trim().length > 0)) {
    chunks.push({
      file: filePath,
      heading: currentHeading || basename(filePath),
      content: currentLines.join('\n').trim(),
    });
  }

  return chunks;
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildMemoryExtractionPrompt(chunks: MemoryChunk[]): string {
  const combined = chunks
    .map(c => `[${c.file} :: ${c.heading}]\n${c.content}`)
    .join('\n\n---\n\n');

  return `从以下 memory 文件片段中提炼可复用的知识条目。这些内容来自工作记忆文件，包含决策、规则、纠偏、经验教训等。

## 核心原则
你在做「原子知识提炼」，不是「文档摘要」。

### 第一步：原子分解 + 去上下文化
- 把内容拆成原子事实（一条决策/纠偏/事实/偏好/规则 = 一条知识）
- 解析所有代词和指代，确保每条知识自包含
- 每条知识必须脱离原始文件上下文后仍然可理解
- 禁止出现"用户说""AI回复"等对话角色描述
- 禁止出现日期时间戳、session ID 等元数据

${buildBehavioralChangeTestSection()}

## 格式约束（强制）
- title: 知识的「名字」，名词性短语，≤10字
- content: 知识的「定义/描述」，≤50字，简洁精炼，自包含
- 每个片段最多提取 5 条，宁缺毋滥
- 没有通过行为变化测试的知识点就返回 []
- 已经是通用常识的内容不提取

## 正确示例
{"title":"禁止doctor --fix","content":"openclaw doctor --fix 被禁止使用，只能手动修复后再跑 doctor 确认"}
{"title":"看板写入方式","content":"写入 subagent-task-board.json 必须用 node local-subagent-board.js enqueue，禁止直接写 JSON"}
{"title":"主会话空闲铁律","content":"主会话只做秒级响应，超过30秒的工作必须派给子Agent"}

## 错误示例（禁止）
✖ title:"2026-04-12 codex排查" ← 包含日期，不是知识名称
✖ content:"用户在09:03说了..." ← 对话摘要
✖ content:"LLM 是大语言模型" ← 通用常识

## 三维标签
1. nature: fact / decision / methodology / experience / meta
2. function: constraint / preference / pattern / principle
3. domain: 开放标签

## 输出格式
纯 JSON 数组：
{"content":"≤50字定义","title":"≤10字名词短语","nature":"<nature>","function":"<function>","domain":"<domain>","source":"memory","confidence":0.0-1.0,"tags":["标签"]}

Memory 片段：
${combined}`;
}

// ── Main extraction ──────────────────────────────────────────────────────────

export async function extractMemoryKnowledge(
  options: ExtractMemoryOptions = {},
): Promise<MemoryExtractResult> {
  const {
    dryRun = false,
    limit,
    memoryDir = resolve('/root/.openclaw/workspace/memory'),
    noQualityGate = false,
  } = options;

  const result: MemoryExtractResult = {
    filesScanned: 0,
    filesSkipped: 0,
    chunksProcessed: 0,
    knowledgeExtracted: 0,
    knowledgeWritten: 0,
    tokenEstimate: 0,
    errors: [],
  };

  // Check memory directory exists
  if (!existsSync(memoryDir)) {
    result.errors.push(`Memory directory not found: ${memoryDir}`);
    return result;
  }

  // Scan for .md files
  const files = readdirSync(memoryDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('.'))
    .sort();

  if (files.length === 0) {
    console.log('No memory files found.');
    return result;
  }

  // Resolve DB path
  const dir = process.cwd();
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = String(DEFAULT_CONFIG.dbPath);
  if (existsSync(configPath)) {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof cfg.dbPath === 'string') dbPath = cfg.dbPath;
  }
  const resolvedDb = resolve(dir, dbPath);

  // Resolve LLM config
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

  // Setup DB
  let db: Database.Database | null = null;
  let repository: KnowledgeRepository | null = null;

  if (!dryRun) {
    if (!existsSync(resolvedDb)) {
      throw new Error(`Database not found at ${resolvedDb}. Run "kivo init" first.`);
    }
    db = new Database(resolvedDb);

    // Ensure required columns exist
    const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
    const colNames = new Set(columns.map(c => c.name));
    if (!colNames.has('nature')) db.exec('ALTER TABLE entries ADD COLUMN nature TEXT');
    if (!colNames.has('function_tag')) db.exec('ALTER TABLE entries ADD COLUMN function_tag TEXT');
    if (!colNames.has('knowledge_domain')) db.exec('ALTER TABLE entries ADD COLUMN knowledge_domain TEXT');
    if (!colNames.has('content_hash')) {
      db.exec('ALTER TABLE entries ADD COLUMN content_hash TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_entries_content_hash ON entries(content_hash) WHERE status = \'active\'');
    }

    // Create processed_memory_files table for file-level dedup
    db.exec(`CREATE TABLE IF NOT EXISTS processed_memory_files (
      file_path TEXT PRIMARY KEY,
      file_hash TEXT NOT NULL,
      processed_at TEXT NOT NULL
    )`);

    const provider = new SQLiteProvider({ dbPath: resolvedDb, configDir: dir });
    repository = new KnowledgeRepository(provider);
  }

  // Load existing file hashes for dedup
  const processedFileHashes = new Map<string, string>();
  if (db) {
    const rows = db.prepare('SELECT file_path, file_hash FROM processed_memory_files').all() as Array<{ file_path: string; file_hash: string }>;
    for (const r of rows) processedFileHashes.set(r.file_path, r.file_hash);
  }

  // Cosine dedup setup
  const COSINE_DEDUP_THRESHOLD = loadDedupThreshold();
  let embedder: BgeEmbedder | null = null;
  let existingEmbeddings: Array<{ id: string; embedding: number[] }> = [];

  if (!dryRun && BgeEmbedder.isAvailable()) {
    embedder = new BgeEmbedder();
    if (db) {
      const rows = db.prepare(
        `SELECT id, metadata_json FROM entries WHERE status = 'active' AND metadata_json IS NOT NULL`
      ).all() as Array<{ id: string; metadata_json: string }>;
      for (const row of rows) {
        try {
          const meta = JSON.parse(row.metadata_json);
          if (meta?.domainData?.embeddingVector && Array.isArray(meta.domainData.embeddingVector)) {
            existingEmbeddings.push({ id: row.id, embedding: meta.domainData.embeddingVector });
          }
        } catch { /* skip malformed */ }
      }
      console.log(`Cosine dedup: loaded ${existingEmbeddings.length} existing embeddings (threshold=${COSINE_DEDUP_THRESHOLD})`);
    }
  } else if (!dryRun) {
    console.log('⚠ BGE embedder not available, cosine dedup disabled (hash dedup still active)');
  }

  // Process each memory file
  let allChunks: MemoryChunk[] = [];
  let consecutive403 = 0;

  for (const file of files) {
    const filePath = join(memoryDir, file);
    const fileContent = readFileSync(filePath, 'utf-8');
    const fileHash = createHash('sha256').update(fileContent).digest('hex');
    result.filesScanned++;

    // File-level dedup: skip if content unchanged
    const previousHash = processedFileHashes.get(filePath);
    if (previousHash === fileHash && !dryRun) {
      console.log(`Skipping unchanged file: ${file}`);
      result.filesSkipped++;
      continue;
    }

    // Split by ## headings
    const chunks = splitByHeadings(fileContent, filePath);
    if (chunks.length === 0) {
      result.filesSkipped++;
      continue;
    }

    allChunks.push(...chunks);

    // Update file hash in DB after processing
    if (!dryRun && db) {
      db.prepare(
        'INSERT INTO processed_memory_files (file_path, file_hash, processed_at) VALUES (?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET file_hash = excluded.file_hash, processed_at = excluded.processed_at'
      ).run(filePath, fileHash, new Date().toISOString());
    }
  }

  // Apply limit
  if (limit !== undefined && limit > 0) {
    allChunks = allChunks.slice(0, limit);
  }

  if (allChunks.length === 0) {
    console.log('No new memory chunks to process.');
    return result;
  }

  console.log(`Processing ${allChunks.length} memory chunks from ${result.filesScanned - result.filesSkipped} files...`);

  // Process chunks in batches of 3 (to keep prompt size manageable)
  const BATCH_SIZE = 3;
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const prompt = buildMemoryExtractionPrompt(batch);
    result.tokenEstimate += estimateTokens(prompt);
    result.chunksProcessed += batch.length;

    if (dryRun) {
      result.knowledgeExtracted += 3; // estimate
      continue;
    }

    try {
      console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allChunks.length / BATCH_SIZE)} (${batch.length} chunks)...`);
      const rawResponse = await llm.complete(prompt);
      consecutive403 = 0;
      const items = parseLlmResponse(rawResponse);
      result.knowledgeExtracted += items.length;

      console.log(`  Extracted ${items.length} knowledge items`);

      const batchHashes = new Set<string>();
      let batchWritten = 0;

      for (const item of items) {
        if (batchWritten >= 5 * batch.length) break; // Max 5 per chunk * batch size
        if (!item.content || item.content.trim().length < 5) continue;

        // Content hash dedup
        const contentHash = createHash('sha256').update(item.content).digest('hex');
        if (batchHashes.has(contentHash)) continue;
        const existingRow = db!.prepare(
          'SELECT id FROM entries WHERE content_hash = ? AND status = \'active\' LIMIT 1'
        ).get(contentHash) as { id: string } | undefined;
        if (existingRow) {
          console.log(`  Skipping duplicate (exists in DB): ${item.content.slice(0, 50)}...`);
          continue;
        }
        batchHashes.add(contentHash);

        // Cosine similarity dedup
        let cosineSkipped = false;
        let itemEmbedding: number[] | null = null;
        if (embedder) {
          try {
            itemEmbedding = await embedder.embed(item.content);
            for (const existing of existingEmbeddings) {
              const sim = cosineSimilarity(itemEmbedding, existing.embedding);
              if (sim >= COSINE_DEDUP_THRESHOLD) {
                console.log(`  Skipping semantic duplicate (cosine=${sim.toFixed(4)}): ${item.content.slice(0, 50)}...`);
                cosineSkipped = true;
                break;
              }
            }
          } catch (embErr) {
            console.log(`  ⚠ Embedding failed, skipping cosine dedup: ${embErr instanceof Error ? embErr.message : String(embErr)}`);
          }
        }
        if (cosineSkipped) continue;

        const nature = validateNature(item.nature);
        const functionTag = validateFunction(item.function);
        const legacyType = nature ? (NATURE_TO_TYPE[nature] ?? 'fact') : 'fact';

        const id = randomUUID();
        const now = new Date();
        const tags = Array.isArray(item.tags) ? item.tags : [];
        const confidence = typeof item.confidence === 'number' ? Math.min(1, Math.max(0, item.confidence)) : 0.7;

        // Source reference includes file path for traceability
        const sourceFile = batch[0]?.file ?? 'memory';
        const entry: KnowledgeEntry = {
          id,
          type: legacyType,
          title: shortenKnowledgeTitle(item.title, item.content),
          content: item.content.slice(0, 50),
          summary: item.content.slice(0, 120),
          source: {
            type: 'document',
            reference: `memory:${basename(sourceFile)}`,
            timestamp: now,
          },
          confidence,
          status: 'active',
          tags,
          domain: item.domain || undefined,
          nature: nature || undefined,
          functionTag: functionTag || undefined,
          knowledgeDomain: item.domain || undefined,
          createdAt: now,
          updatedAt: now,
          version: 1,
          metadata: {
            domainData: {
              contentHash,
              sourceType: 'memory',
              sourceFile: basename(sourceFile),
              ...(itemEmbedding ? { embeddingVector: itemEmbedding, embeddingModel: 'bge-small-zh-v1.5' } : {}),
            },
          },
        };

        const saved = await repository!.save(entry, { skipQualityGate: noQualityGate });
        if (saved) {
          result.knowledgeWritten++;
          batchWritten++;
          if (itemEmbedding) {
            existingEmbeddings.push({ id: entry.id, embedding: itemEmbedding });
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${errMsg}`);
      if (errMsg.includes('403')) {
        consecutive403++;
        if (consecutive403 >= 3) {
          result.errors.push('Aborting: 3 consecutive 403 errors. Check API key/provider.');
          break;
        }
      }
    }
  }

  // Rebuild FTS index
  if (db) {
    try { db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`); } catch { /* non-fatal */ }
    await repository?.close();
    db.close();
  }

  if (embedder) {
    await embedder.close();
  }

  return result;
}

export function formatMemoryResult(result: MemoryExtractResult, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(dryRun ? '=== Memory Knowledge Extraction (DRY RUN) ===' : '=== Memory Knowledge Extraction ===');
  lines.push(`Files scanned:       ${result.filesScanned}`);
  lines.push(`Files skipped:       ${result.filesSkipped} (unchanged)`);
  lines.push(`Chunks processed:    ${result.chunksProcessed}`);
  lines.push(`Knowledge extracted: ${result.knowledgeExtracted}`);
  if (!dryRun) {
    lines.push(`Knowledge written:   ${result.knowledgeWritten}`);
  }
  lines.push(`Token estimate:      ~${result.tokenEstimate.toLocaleString()}`);
  if (result.errors.length > 0) {
    lines.push(`\nErrors (${result.errors.length}):`);
    for (const e of result.errors) {
      lines.push(`  ✗ ${e}`);
    }
  }
  return lines.join('\n');
}
