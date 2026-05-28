import { createHash, randomUUID } from 'node:crypto';
import type { KnowledgeFunction, KnowledgeNature, KnowledgeType } from '../types/index.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import { buildBehavioralChangeTestSection, buildKnowledgeAdmissionBoundarySection } from '../standards/index.js';
import { parseLlmResponse, validateFunction, validateNature, NATURE_TO_TYPE, type ExtractedItem } from './session-knowledge-llm.js';

export interface KnowledgeMaterial {
  clusterId: number;
  clusterSize: number;
  content: string;
  title?: string;
  nature?: string;
  function?: string;
  domain?: string;
  source?: string;
  confidence?: number;
  tags?: string[];
  similarSentences?: string[];
  sourceRefs: Array<{
    sessionId: string;
    timestamp: string;
  }>;
}

export interface AggregatedKnowledgeItem extends ExtractedItem {
  materialIds: string[];
  sourceRefs: Array<{
    sessionId: string;
    timestamp: string;
  }>;
}

export interface AggregationResult {
  items: AggregatedKnowledgeItem[];
  materialsConsumed: number;
  themeGroups: number;
}

function materialId(material: KnowledgeMaterial): string {
  return createHash('sha256')
    .update(`${material.clusterId}:${material.content}`)
    .digest('hex')
    .slice(0, 16);
}

function buildAggregationPrompt(materials: KnowledgeMaterial[]): string {
  const materialList = materials.map((m, idx) => {
    const refs = m.sourceRefs.map(r => `${r.sessionId}@${r.timestamp}`).join(', ');
    return `### 素材 ${idx + 1}
标题：${m.title ?? ''}
领域：${m.domain ?? ''}
标签：${(m.tags ?? []).join(', ')}
相似表述：${(m.similarSentences ?? []).join(' | ')}
来源：${refs}
内容：${m.content}`;
  }).join('\n\n');

  return `你是 KIVO 的知识萃取器。输入是一批 staging 素材，不是最终知识。你的任务分两步完成：先按主题做语义聚类，再把每个主题簇抽象、综合、沉淀为跨场景原则。

${buildKnowledgeAdmissionBoundarySection()}

${buildBehavioralChangeTestSection()}

## 聚合规则
1. 主题聚类必须由你基于语义理解完成，禁止使用关键词匹配、正则、FTS5 或规则引擎。
2. 多条素材表达同一长期机制时，合并成一条抽象知识。
3. 一次性决策、临时调度、排查过程、任务派发、阶段性状态，不能直接产出知识。
4. 如果素材只能证明「当时发生过什么」，不能证明「以后应如何理解或行动」，返回 []。
5. 每条产出必须同时通过三个问题：三个月后还有效吗？换项目/换任务还适用吗？去掉时间、人名、项目名后仍有指导价值吗？
6. title 必须是 LLM 抽象归纳后的完整名词短语（≤20字），不能直接用原文当标题，不能写半句话，不能靠省略号或硬截断凑长度。
7. content 必须是 LLM 归纳后的结构化描述，独立于 title 详细说明场景、原则、原因；content 不能和 title 相同，也不能只是 title 的重复。
8. similar_sentences 必须生成 2-3 条泛化相似表述，用于后续语义检索匹配；可参考输入素材里的相似表述，但不能照搬原文。
9. 允许一批素材产出 0 条。宁缺毋滥。
10. 每条知识必须回答：它让 agent 在什么场景下避免什么错误。

## 输出约束
- title：LLM 抽象归纳后的完整名词短语，≤20字，禁止半句截断，禁止以 ... 或 … 结尾。
- content：自包含，直接陈述可复用理解，包含场景、原则、原因；不能和 title 相同，不能只重复 title。
- similar_sentences：2-3 条泛化相似表述，用于语义检索匹配。
- 禁止写「用户说」「这次」「当前」「刚才」「今天」「已完成」「正在」等对话过程词。
- nature：fact / concept / rule / procedure / heuristic。
- function：routing / quality_gate / context_enrichment / decision_support / correction。
- domain：开放标签。
- materialIds：使用输入素材序号，如 [1,2]。

返回纯 JSON 数组：
[{"title":"≤20字完整短标题","content":"独立详细描述：场景+原则+原因，不能和 title 相同","nature":"rule","function":"quality_gate","domain":"","source":"session-aggregate","confidence":0.0,"tags":[""],"similar_sentences":["泛化表述1","泛化表述2"],"materialIds":[1,2]}]

输入素材：
${materialList}`;
}

function parseAggregatedResponse(raw: string, materials: KnowledgeMaterial[]): AggregatedKnowledgeItem[] {
  const parsed = parseLlmResponse(raw) as Array<ExtractedItem & { materialIds?: unknown }>;
  const byOrdinal = new Map<number, KnowledgeMaterial>();
  materials.forEach((m, idx) => byOrdinal.set(idx + 1, m));

  return parsed.map(item => {
    const ordinals = Array.isArray(item.materialIds)
      ? item.materialIds
          .map(v => typeof v === 'number' ? v : Number.parseInt(String(v), 10))
          .filter(n => Number.isInteger(n) && byOrdinal.has(n))
      : [];
    const selected = ordinals.length > 0 ? ordinals.map(n => byOrdinal.get(n)!) : materials;
    const sourceRefs = selected.flatMap(m => m.sourceRefs);
    return {
      ...item,
      similarSentences: Array.isArray(item.similar_sentences)
        ? item.similar_sentences.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 3)
        : Array.isArray(item.similarSentences)
          ? item.similarSentences.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 3)
          : undefined,
      materialIds: selected.map(materialId),
      sourceRefs,
    };
  });
}

function parseEnvInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const MAX_MATERIALS_PER_RUN = parseEnvInteger(
  process.env.KIVO_AGGREGATOR_MAX_MATERIALS,
  100,
);

export async function aggregateKnowledgeMaterials(
  llm: OpenAILLMProvider,
  materials: KnowledgeMaterial[],
  maxMaterialsPerRun = MAX_MATERIALS_PER_RUN,
): Promise<AggregationResult> {
  const usable = materials.filter(m => m.content.trim().length > 0);
  const materialsForRun = maxMaterialsPerRun > 0 ? usable.slice(0, maxMaterialsPerRun) : usable;

  const items: AggregatedKnowledgeItem[] = [];
  if (materialsForRun.length > 0) {
    const raw = await llm.complete(buildAggregationPrompt(materialsForRun));
    items.push(...parseAggregatedResponse(raw, materialsForRun));
  }

  return {
    items,
    materialsConsumed: materialsForRun.length,
    themeGroups: items.length,
  };
}

export function extractedItemToMaterial(
  clusterId: number,
  clusterSize: number,
  item: ExtractedItem,
  sourceRefs: KnowledgeMaterial['sourceRefs'],
): KnowledgeMaterial {
  return {
    clusterId,
    clusterSize,
    content: item.content,
    title: item.title,
    nature: item.nature,
    function: item.function,
    domain: item.domain,
    source: item.source,
    confidence: item.confidence,
    tags: item.tags,
    similarSentences: Array.isArray(item.similar_sentences)
      ? item.similar_sentences.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 3)
      : Array.isArray(item.similarSentences)
        ? item.similarSentences.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 3)
        : undefined,
    sourceRefs,
  };
}

export function normalizeAggregatedItem(item: AggregatedKnowledgeItem): {
  title: string;
  content: string;
  nature?: KnowledgeNature;
  functionTag?: KnowledgeFunction;
  legacyType: KnowledgeType;
  domain?: string;
  confidence: number;
  tags: string[];
  similarSentences?: string[];
  provenance: Record<string, unknown>;
} {
  const nature = validateNature(item.nature) as KnowledgeNature | undefined;
  const functionTag = validateFunction(item.function) as KnowledgeFunction | undefined;
  const legacyType = (nature ? (NATURE_TO_TYPE[nature] ?? 'fact') : 'fact') as KnowledgeType;
  const content = item.content.trim();
  const confidence = typeof item.confidence === 'number' ? Math.min(1, Math.max(0, item.confidence)) : 0.7;
  return {
    title: shortenKnowledgeTitle(item.title, content),
    content,
    nature,
    functionTag,
    legacyType,
    domain: item.domain || undefined,
    confidence,
    tags: Array.isArray(item.tags) ? item.tags : [],
    similarSentences: Array.isArray(item.similar_sentences)
      ? item.similar_sentences.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 3)
      : Array.isArray(item.similarSentences)
        ? item.similarSentences.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 3)
        : undefined,
    provenance: {
      createdByProcess: 'session-knowledge-aggregation',
      materialIds: item.materialIds,
      sourceRefs: item.sourceRefs,
      aggregationId: randomUUID(),
    },
  };
}
