import type { LLMProvider } from '../adapter/llm-provider.js';
import type { KnowledgeEntry } from '../types/index.js';

export type MultiDimNature = 'fact' | 'decision' | 'methodology' | 'experience' | 'meta';
export type MultiDimFunction = 'constraint' | 'preference' | 'pattern' | 'principle';

export interface MultiDimTagResult {
  nature: MultiDimNature;
  function: MultiDimFunction;
  domain: string;
}

export interface MultiDimTaggedEntry {
  entry: KnowledgeEntry;
  tags: MultiDimTagResult;
}

export interface MultiDimTaggerOptions {
  llm: LLMProvider;
  batchSize?: number;
}

interface BatchTagResult extends MultiDimTagResult {
  index: number;
}

const NATURES: readonly MultiDimNature[] = ['fact', 'decision', 'methodology', 'experience', 'meta'];
const FUNCTIONS: readonly MultiDimFunction[] = ['constraint', 'preference', 'pattern', 'principle'];

export class MultiDimTagger {
  private readonly llm: LLMProvider;
  private readonly batchSize: number;

  constructor(options: MultiDimTaggerOptions) {
    this.llm = options.llm;
    this.batchSize = Math.max(1, options.batchSize ?? 10);
  }

  async tagEntry(entry: KnowledgeEntry): Promise<MultiDimTagResult> {
    const [tag] = await this.tagEntries([entry]);
    if (!tag) {
      throw new Error(`LLM did not return tags for entry ${entry.id}`);
    }
    return tag.tags;
  }

  async batchRetag(entries: KnowledgeEntry[]): Promise<MultiDimTaggedEntry[]> {
    const tagged: MultiDimTaggedEntry[] = [];
    for (let index = 0; index < entries.length; index += this.batchSize) {
      tagged.push(...await this.tagEntries(entries.slice(index, index + this.batchSize)));
    }
    return tagged;
  }

  private async tagEntries(entries: KnowledgeEntry[]): Promise<MultiDimTaggedEntry[]> {
    if (entries.length === 0) return [];

    const response = await this.llm.complete(buildTaggingPrompt(entries));
    const parsed = parseTagResponse(response);
    const tagged: MultiDimTaggedEntry[] = [];

    for (const item of parsed) {
      if (item.index < 0 || item.index >= entries.length) continue;
      const normalized = normalizeTag(item);
      if (!normalized) continue;
      tagged.push({
        entry: entries[item.index],
        tags: normalized,
      });
    }

    return tagged;
  }
}

export function toKnowledgeEntryPatch(tags: MultiDimTagResult): Pick<KnowledgeEntry, 'nature' | 'functionTag' | 'knowledgeDomain'> {
  return {
    nature: tags.nature,
    functionTag: tags.function,
    knowledgeDomain: tags.domain,
  };
}

function buildTaggingPrompt(entries: KnowledgeEntry[]): string {
  const payload = entries.map((entry, index) => ({
    index,
    type: entry.type,
    title: entry.title,
    content: entry.content.slice(0, 1200),
    summary: entry.summary,
    currentDomain: entry.domain ?? entry.knowledgeDomain,
    tags: entry.tags,
  }));

  return `你是知识库三维标签器。必须只根据语义理解判断，禁止按关键词、正则或标题模板机械分类。

为每条知识打三维标签：
- nature: fact / decision / methodology / experience / meta
- function: constraint / preference / pattern / principle
- domain: 用 1-3 个英文小写词表达领域，如 coding、product、ops、design、agent-scheduling

判定要求：
- nature 表示知识本身是什么。
- function 表示这条知识在 Agent 行为中起什么作用。
- domain 必须从内容语义归纳，不能照抄单个关键词。

只输出纯 JSON 数组，每条格式：
{"index":0,"nature":"fact","function":"constraint","domain":"ops"}

知识条目：
${JSON.stringify(payload, null, 2)}`;
}

function parseTagResponse(raw: string): BatchTagResult[] {
  const cleaned = stripJsonFence(raw);
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isBatchTagResult);
  } catch {
    return [];
  }
}

function stripJsonFence(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned;
}

function isBatchTagResult(value: unknown): value is BatchTagResult {
  const item = value as Partial<BatchTagResult>;
  return typeof value === 'object'
    && value !== null
    && typeof item.index === 'number'
    && typeof item.nature === 'string'
    && typeof item.function === 'string'
    && typeof item.domain === 'string';
}

function normalizeTag(item: BatchTagResult): MultiDimTagResult | null {
  if (!isNature(item.nature) || !isFunction(item.function)) {
    return null;
  }

  const domain = normalizeDomain(item.domain);
  if (!domain) {
    return null;
  }

  return {
    nature: item.nature,
    function: item.function,
    domain,
  };
}

function isNature(value: string): value is MultiDimNature {
  return (NATURES as readonly string[]).includes(value);
}

function isFunction(value: string): value is MultiDimFunction {
  return (FUNCTIONS as readonly string[]).includes(value);
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 80);
}
