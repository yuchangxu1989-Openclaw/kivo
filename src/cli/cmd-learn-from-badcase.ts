/**
 * kivo learn-from-badcase — Convert badcases into intent knowledge entries (FR-N02)
 *
 * AC coverage:
 *   AC1: Identifies three source types (via badcase-extractor)
 *   AC2: LLM semantic extraction (via badcase-extractor)
 *   AC3: Stores as Knowledge Entry type=intent, walks standard pipeline
 *   AC4: Auto-annotates source type and source date
 *   AC5: CLI with --source <path> and --dry-run
 *   AC6: BGE vector dedup via MECE governance checkDuplicate()
 *   AC7: All semantic work via LLM (enforced in badcase-extractor)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import { parseBadcaseFile, parseBadcaseText, extractIntentsFromBadcases } from './badcase-extractor.js';
import { checkPreIngestDuplicate } from './mece-governance.js';
import type { BadcaseEntry } from './badcase-extractor.js';

/**
 * Simple text overlap using character trigram Jaccard similarity.
 * Used for FTS-based dedup when BGE embeddings are unavailable.
 */
function computeTextOverlap(a: string, b: string): number {
  const ngramSize = 3;
  const gramsA = new Set<string>();
  const gramsB = new Set<string>();
  for (let i = 0; i <= a.length - ngramSize; i++) gramsA.add(a.slice(i, i + ngramSize));
  for (let i = 0; i <= b.length - ngramSize; i++) gramsB.add(b.slice(i, i + ngramSize));
  if (gramsA.size === 0 || gramsB.size === 0) return 0;
  let intersection = 0;
  for (const g of gramsA) { if (gramsB.has(g)) intersection++; }
  return intersection / (gramsA.size + gramsB.size - intersection);
}

export interface LearnFromBadcaseOptions {
  source?: string;
  dryRun?: boolean;
  json?: boolean;
  cwd?: string;
}

interface LearnResult {
  badcasesFound: number;
  intentsExtracted: number;
  intentsWritten: number;
  duplicatesSkipped: number;
  errors: string[];
}

function resolveDbPath(dir: string): string {
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);
  if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }
  return resolve(dir, dbPath);
}

/**
 * Collect badcase entries from a source path (file or directory).
 */
async function collectBadcases(sourcePath: string): Promise<BadcaseEntry[]> {
  const resolved = resolve(sourcePath);
  if (!existsSync(resolved)) {
    throw new Error(`Source path not found: ${sourcePath}`);
  }

  const stat = statSync(resolved);
  if (stat.isFile()) {
    return parseBadcaseFile(resolved);
  }

  if (stat.isDirectory()) {
    const entries: BadcaseEntry[] = [];
    const files = readdirSync(resolved)
      .filter(f => ['.md', '.txt', '.json'].includes(extname(f).toLowerCase()))
      .sort();

    for (const file of files) {
      const filePath = join(resolved, file);
      try {
        entries.push(...await parseBadcaseFile(filePath));
      } catch (err) {
        console.error(`⚠ Failed to parse ${file}: ${(err as Error).message}`);
      }
    }
    return entries;
  }

  throw new Error(`Source path is neither a file nor directory: ${sourcePath}`);
}

/**
 * Read badcases from stdin if no --source is provided.
 */
function readStdin(): string {
  try {
    return readFileSync('/dev/stdin', 'utf-8');
  } catch {
    return '';
  }
}

export async function runLearnFromBadcase(options: LearnFromBadcaseOptions = {}): Promise<string> {
  const dir = resolve(options.cwd ?? process.cwd());
  const dbPath = resolveDbPath(dir);

  if (!existsSync(dbPath) && !options.dryRun) {
    return options.json
      ? JSON.stringify({ error: 'Database not found. Run `kivo init` first.' })
      : '✗ Database not found. Run `kivo init` first.';
  }

  // AC5: Collect badcases from --source or stdin
  let badcases: BadcaseEntry[];
  if (options.source) {
    try {
      badcases = await collectBadcases(options.source);
    } catch (err) {
      const msg = (err as Error).message;
      return options.json ? JSON.stringify({ error: msg }) : `✗ ${msg}`;
    }
  } else {
    const stdinText = readStdin();
    if (!stdinText.trim()) {
      return options.json
        ? JSON.stringify({ error: 'No input. Use --source <path> or pipe text via stdin.' })
        : '✗ No input. Use --source <path> or pipe text via stdin.';
    }
    badcases = await parseBadcaseText(stdinText);
  }

  if (badcases.length === 0) {
    return options.json
      ? JSON.stringify({ badcasesFound: 0, intentsExtracted: 0, intentsWritten: 0 })
      : '✗ No badcases found in the provided source.';
  }

  console.log(`Found ${badcases.length} badcase(s). Extracting intents via LLM...`);

  const result: LearnResult = {
    badcasesFound: badcases.length,
    intentsExtracted: 0,
    intentsWritten: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  // AC2 + AC7: LLM extraction
  let intents;
  try {
    intents = await extractIntentsFromBadcases(badcases);
    result.intentsExtracted = intents.length;
  } catch (err) {
    const msg = (err as Error).message;
    result.errors.push(msg);
    return options.json
      ? JSON.stringify(result)
      : `✗ LLM extraction failed: ${msg}`;
  }

  if (intents.length === 0) {
    return options.json
      ? JSON.stringify(result)
      : '⚠ LLM extracted 0 intents from the provided badcases.';
  }

  if (options.dryRun) {
    // AC5: --dry-run preview
    const lines = [`[DRY-RUN] Extracted ${intents.length} intent(s) from ${badcases.length} badcase(s):\n`];
    for (const intent of intents) {
      lines.push(`  ▸ [${intent.sourceType}] ${intent.title}`);
      lines.push(`    场景: ${intent.scenario}`);
      lines.push(`    触发: ${intent.triggerCondition}`);
      lines.push(`    预期: ${intent.expectedBehavior}`);
      lines.push(`    反模式: ${intent.antiPattern}`);
      lines.push(`    置信度: ${intent.confidence}`);
      lines.push('');
    }
    return options.json ? JSON.stringify({ ...result, dryRun: true, intents }) : lines.join('\n');
  }

  // AC3 + AC4 + AC6: Store as intent entries with dedup
  const db = new Database(dbPath);

  // Ensure columns exist
  const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
  const colNames = new Set(columns.map(c => c.name));
  if (!colNames.has('similar_sentences')) db.exec(`ALTER TABLE entries ADD COLUMN similar_sentences TEXT DEFAULT '[]'`);
  if (!colNames.has('nature')) db.exec('ALTER TABLE entries ADD COLUMN nature TEXT');
  if (!colNames.has('function_tag')) db.exec('ALTER TABLE entries ADD COLUMN function_tag TEXT');
  if (!colNames.has('knowledge_domain')) db.exec('ALTER TABLE entries ADD COLUMN knowledge_domain TEXT');

  try {
    for (const intent of intents) {
      // AC6: Dedup check via MECE governance (BGE vector dedup)
      try {
        // Try to generate embedding for dedup check
        // Try BGE embedding for vector dedup
        let usedVector = false;
        try {
          const { BgeEmbedder } = await import('../extraction/bge-embedder.js');
          const embedder = new BgeEmbedder();
          const vector = await embedder.embed(intent.content);
          await embedder.close();
          if (vector && vector.length > 0) {
            const dupCheck = checkPreIngestDuplicate(vector, dbPath);
            if (dupCheck.isDuplicate) {
              console.log(`  ⊘ Duplicate skipped: "${intent.title}" (matches ${dupCheck.matchedEntryId}, sim=${dupCheck.similarity?.toFixed(2)})`);
              result.duplicatesSkipped++;
              usedVector = true;
            }
          }
        } catch { /* BGE unavailable, fall through to FTS */ }
        if (usedVector) continue;
        if (!usedVector) {
          // Trigram FTS dedup: use first meaningful substring from content
          const searchSubstr = intent.content
            .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
            .trim()
            .slice(0, 30)
            .trim();
          if (searchSubstr && searchSubstr.length >= 3) {
            const matches = db.prepare(`
              SELECT e.id, e.content FROM entries e
              JOIN entries_fts ON entries_fts.rowid = e.rowid
              WHERE entries_fts MATCH ? AND e.status = 'active'
              LIMIT 3
            `).all(searchSubstr) as Array<{ id: string; content: string }>;
            const isDup = matches.some(m => {
              const overlap = computeTextOverlap(intent.content, m.content);
              return overlap > 0.85;
            });
            if (isDup) {
              console.log(`  ⊘ Duplicate skipped (FTS): "${intent.title}"`);
              result.duplicatesSkipped++;
              continue;
            }
          }
        }
      } catch {
        // Dedup check failed, proceed with insertion (non-fatal)
      }

      const id = randomUUID();
      const now = new Date().toISOString();

      // AC4: Source annotation with type and date
      const sourceJson = JSON.stringify({
        type: 'manual' as const,
        reference: `badcase:${intent.sourceType}`,
        timestamp: intent.sourceDate,
        context: `Extracted from badcase (${intent.sourceType}) dated ${intent.sourceDate}`,
      });

      const tagsJson = JSON.stringify(intent.tags);
      const similarSentencesJson = JSON.stringify(intent.similarSentences);

      // AC3: Store as type=intent with structured content
      const structuredContent = [
        intent.content,
        '',
        `场景: ${intent.scenario}`,
        `触发条件: ${intent.triggerCondition}`,
        `预期行为: ${intent.expectedBehavior}`,
        `反模式: ${intent.antiPattern}`,
      ].join('\n');

      db.prepare(`
        INSERT INTO entries (id, type, title, content, summary, source_json, confidence, status, tags_json, domain, version, similar_sentences, nature, function_tag, knowledge_domain, created_at, updated_at)
        VALUES (?, 'intent', ?, ?, ?, ?, ?, 'active', ?, NULL, 1, ?, 'rule', 'correction', NULL, ?, ?)
      `).run(
        id,
        shortenKnowledgeTitle(intent.title, structuredContent),
        structuredContent,
        intent.content.slice(0, 120),
        sourceJson,
        intent.confidence,
        tagsJson,
        similarSentencesJson,
        now,
        now,
      );

      result.intentsWritten++;
      console.log(`  ✓ Stored: "${intent.title}" (${id.slice(0, 8)})`);
    }

    // Rebuild FTS index
    try { db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`); } catch { /* non-fatal */ }
  } finally {
    db.close();
  }

  if (options.json) {
    return JSON.stringify(result);
  }

  const lines = [
    `✓ Learned from ${result.badcasesFound} badcase(s):`,
    `  Intents extracted: ${result.intentsExtracted}`,
    `  Intents written:   ${result.intentsWritten}`,
    `  Duplicates skipped: ${result.duplicatesSkipped}`,
  ];
  if (result.errors.length > 0) {
    lines.push(`  Errors: ${result.errors.join('; ')}`);
  }
  return lines.join('\n');
}
