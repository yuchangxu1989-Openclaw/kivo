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
  why?: string;
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
记录理由：${m.why ?? ''}
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
6. title 必须是口语化一句话（≤20字），像跟同事聊天说"你知道吗，XXX"。禁止写成名词短语或 AI 摘要，禁止用 Agent/pipeline/hook 等技术术语做主语。好："发现问题后必须派人修"。坏："场景应用边界"。
7. content/description 必须比标题多一层细节，用一两句话说清楚「什么场景下、该做什么、不做会怎样」。禁止和 title 高度重复。
8. why 必须独立于 content，一句话说"为什么值得记住"——踩坑代价或违反后果。why 禁止复制 content/description/summary/title，也不能只是改写复述；无法从素材可靠推断时返回空字符串 ""。
9. similar_sentences 必须生成 2-3 条泛化相似表述，用于后续语义检索匹配；可参考输入素材里的相似表述，但不能照搬原文。
10. 允许一批素材产出 0 条。宁缺毋滥。
11. 每条知识必须回答：它让 agent 在什么场景下避免什么错误。

## 输出约束
- title：口语化一句话，≤20字，像跟同事聊天时说的话。禁止名词短语、AI 摘要风格。
- content/description：比标题多一层细节，说清楚场景+做法+不做会怎样。禁止和 title 高度重复。
- why：独立于 content，一句话说踩坑代价或违反后果。禁止相同或改写复述；无法推断时填空字符串 ""。
- similar_sentences：2-3 条泛化相似表述，用于语义检索匹配。
- 禁止写「用户说」「这次」「当前」「刚才」「今天」「已完成」「正在」等对话过程词。
- nature：fact / concept / rule / procedure / heuristic。
- function：routing / quality_gate / context_enrichment / decision_support / correction。
- domain：开放标签。
- materialIds：使用输入素材序号，如 [1,2]。

返回纯 JSON 数组：
[{"title":"≤20字口语化短句","content":"比标题多一层：什么场景下做什么、不做会怎样","why":"为什么值得记住；无法推断则为空字符串","nature":"rule","function":"quality_gate","domain":"","source":"session-aggregate","confidence":0.0,"tags":[""],"similar_sentences":["泛化表述1","泛化表述2"],"materialIds":[1,2]}]

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
    why: item.why,
    sourceRefs,
  };
}

function normalizeWhy(raw: string | undefined, content: string): string | undefined {
  const why = raw?.trim() ?? '';
  if (!why || why === '待补充') return undefined;
  const normalizedWhy = why.replace(/\s+/g, ' ');
  const normalizedContent = content.trim().replace(/\s+/g, ' ');
  return normalizedWhy === normalizedContent ? undefined : why;
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
  why?: string;
  provenance: Record<string, unknown>;
} {
  const nature = validateNature(item.nature) as KnowledgeNature | undefined;
  const functionTag = validateFunction(item.function) as KnowledgeFunction | undefined;
  const legacyType = (nature ? (NATURE_TO_TYPE[nature] ?? 'fact') : 'fact') as KnowledgeType;
  const content = item.content.trim();
  const why = normalizeWhy(item.why, content);
  const confidence = typeof item.confidence === 'number' ? Math.min(1, Math.max(0, item.confidence)) : 0.7;
  return {
    title: shortenKnowledgeTitle(item.title, content),
    content,
    why,
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
