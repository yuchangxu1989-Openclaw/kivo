import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KnowledgeRepository, SQLiteProvider } from '../repository/index.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import type { KnowledgeType, KnowledgeEntry } from '../types/index.js';
import { formatLlmProviderError, resolveLlmConfig } from './resolve-llm-config.js';

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
export class CliUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUserError';
  }
}

function assertLlmConfiguredForQualityGate(): void {
  const config = resolveLlmConfig();
  if ('error' in config) {
    throw new CliUserError(config.error);
  }
}

function formatQualityGateRejection(): string {
  return formatLlmProviderError('quality gate / ValueGate 需要 LLM 判断知识是否值得入库。');
}

export async function runAdd(type: string, title: string, options: AddOptions = {}): Promise<string> {
  if (!type || !title) {
    throw new CliUserError('Usage: kivo add <type> <title> [--content "..."] [--tags "a,b"] [--source "..."] [--confidence 0.8] [--domain "..."] [--json] [--no-quality-gate]');
  }

  if (!VALID_TYPES.includes(type as KnowledgeType)) {
    throw new CliUserError(`Invalid type "${type}". Valid types: ${VALID_TYPES.join(', ')}`);
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
    throw new CliUserError('Database not found. Run "kivo init" first.');
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
    throw new CliUserError('Confidence must be a number between 0 and 1.');
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

  if (!options.noQualityGate) {
    assertLlmConfiguredForQualityGate();
  }

  const provider = new SQLiteProvider({ dbPath: resolvedDb, configDir: dir });
  const repository = new KnowledgeRepository(provider);
  try {
    const skipAllGates = !!options.noQualityGate;
    const saved = await repository.save(entry, {
      skipQualityGate: skipAllGates,
      skipDedup: skipAllGates,
      skipEmbedding: true,
    });
    if (!saved) {
      throw new CliUserError(formatQualityGateRejection());
    }
  } finally {
    await repository.close();
  }

  if (options.json) {
    return JSON.stringify({ id, type, title: normalizedTitle, content, tags, confidence, status, domain, createdAt: now, embeddingDeferred: true }, null, 2);
  }

  return `✓ Added [${type}] "${normalizedTitle}" (id: ${id})\nℹ 向量化已延迟到批量处理。配置 embedding provider 后运行 npx kivo embed-backfill 启用语义检索。`;
}
