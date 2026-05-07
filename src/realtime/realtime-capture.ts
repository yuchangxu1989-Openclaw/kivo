import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../adapter/llm-provider.js';
import type { KnowledgeEntry, KnowledgeSource } from '../types/index.js';
import { KnowledgeRepository } from '../repository/knowledge-repository.js';
import { SQLiteProvider } from '../repository/sqlite-provider.js';
import {
  clampConfidence,
  extractJsonBlock,
  generateTitle,
  isKnowledgeType,
} from '../extraction/extraction-utils.js';

export interface RealtimeCaptureOptions {
  dbPath: string;
  llmProvider: LLMProvider;
  minConfidence?: number;
}

export interface CaptureResult {
  captured: number;
  entries: KnowledgeEntry[];
  skipped: number;
}

const EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Given a user message from a conversation, extract any reusable knowledge entries.

Return a JSON array of objects with these fields:
- type: one of "fact", "methodology", "decision", "experience", "intent", "meta"
- title: concise title (max 50 chars)
- content: the knowledge content
- summary: one-line summary
- confidence: 0-1 how confident this is useful knowledge
- tags: string array of relevant tags

If no knowledge can be extracted, return an empty array [].
Only return the JSON array, no other text.

Message:
`;

/**
 * Capture knowledge from a real-time message.
 * Calls the extraction engine, filters by confidence, and persists to DB.
 */
export async function captureFromMessage(
  message: string,
  sessionId: string,
  options: RealtimeCaptureOptions,
): Promise<CaptureResult> {
  const { llmProvider, dbPath, minConfidence = 0.7 } = options;

  if (!message.trim()) {
    return { captured: 0, entries: [], skipped: 0 };
  }

  // 1. Call LLM to extract knowledge candidates
  const prompt = EXTRACTION_PROMPT + message;
  const raw = await llmProvider.complete(prompt);
  const extracted = extractJsonBlock(raw);

  let candidates: Array<{
    type?: string;
    title?: string;
    content?: string;
    summary?: string;
    confidence?: number;
    tags?: string[];
  }>;

  try {
    const parsed = typeof extracted === 'string' ? JSON.parse(extracted) : extracted;
    candidates = Array.isArray(parsed) ? parsed : [];
  } catch {
    // LLM returned non-JSON; no knowledge extracted
    return { captured: 0, entries: [], skipped: 0 };
  }

  // 2. Filter by confidence threshold
  const now = new Date();
  const source: KnowledgeSource = {
    type: 'conversation',
    reference: `session:${sessionId}`,
    timestamp: now,
    context: message.slice(0, 200),
  };

  const entries: KnowledgeEntry[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    const confidence = clampConfidence(candidate.confidence);
    if (confidence < minConfidence) {
      skipped++;
      continue;
    }

    const type = isKnowledgeType(candidate.type) ? candidate.type : 'fact';
    const content = candidate.content ?? message;
    const title = candidate.title ?? generateTitle(content);

    const entry: KnowledgeEntry = {
      id: randomUUID(),
      type,
      title,
      content,
      summary: candidate.summary ?? title,
      source,
      confidence,
      status: 'active',
      tags: Array.isArray(candidate.tags) ? candidate.tags : [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    entries.push(entry);
  }

  // 3. Persist to database
  if (entries.length > 0) {
    const provider = new SQLiteProvider({ dbPath });
    const repo = new KnowledgeRepository(provider);
    try {
      for (const entry of entries) {
        await repo.save(entry);
      }
    } finally {
      await repo.close();
    }
  }

  return { captured: entries.length, entries, skipped };
}
