import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KnowledgeRepository, SQLiteProvider } from '../repository/index.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import type { KnowledgeType, KnowledgeEntry } from '../types/index.js';

const VALID_TYPES: KnowledgeType[] = ['fact', 'methodology', 'decision', 'experience', 'intent', 'meta'];

export interface AddOptions {
  content?: string;
  tags?: string;
  source?: string;
  confidence?: string;
  domain?: string;
  status?: string;
  json?: boolean;
  noQualityGate?: boolean;
}

export async function runAdd(type: string, title: string, options: AddOptions = {}): Promise<string> {
  if (!type || !title) {
    return 'Usage: kivo add <type> <title> [--content "..."] [--tags "a,b"] [--source "..."] [--confidence 0.8] [--domain "..."] [--json]';
  }

  if (!VALID_TYPES.includes(type as KnowledgeType)) {
    return `Invalid type "${type}". Valid types: ${VALID_TYPES.join(', ')}`;
  }

  const dir = process.cwd();
  const configPath = join(dir, 'kivo.config.json');

  let dbPath = String(DEFAULT_CONFIG.dbPath);
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }

  const resolvedDb = resolve(dir, dbPath);
  if (!existsSync(resolvedDb)) {
    return 'Database not found. Run "kivo init" first.';
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const content = options.content ?? '';
  const normalizedTitle = shortenKnowledgeTitle(title, content);
  const tags = options.tags ? options.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  const confidence = options.confidence ? parseFloat(options.confidence) : 0.7;
  const domain = options.domain ?? null;
  const status = options.status ?? 'active';
  const sourceRef = options.source ?? 'cli';

  if (confidence < 0 || confidence > 1 || isNaN(confidence)) {
    return 'Confidence must be a number between 0 and 1.';
  }

  const entry: KnowledgeEntry = {
    id,
    type: type as KnowledgeType,
    title: normalizedTitle,
    content,
    summary: '',
    source: {
      type: 'manual',
      reference: sourceRef,
      timestamp: new Date(now),
    },
    confidence,
    status: status as any,
    tags,
    domain: domain ?? undefined,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    version: 1,
  };

  const provider = new SQLiteProvider({ dbPath: resolvedDb, configDir: dir });
  const repository = new KnowledgeRepository(provider);
  try {
    const saved = await repository.save(entry, { skipQualityGate: !!options.noQualityGate, skipEmbedding: true });
    if (!saved) {
      return '质量门禁拒绝入库，请检查 quality_gate_log。';
    }
  } finally {
    await repository.close();
  }

  if (options.json) {
    return JSON.stringify({ id, type, title: normalizedTitle, content, tags, confidence, status, domain, createdAt: now, embeddingDeferred: true }, null, 2);
  }

  return `✓ Added [${type}] "${normalizedTitle}" (id: ${id})\nℹ 向量化已延迟到批量处理（kivo embed-backfill），关键词检索正常。`;
}
