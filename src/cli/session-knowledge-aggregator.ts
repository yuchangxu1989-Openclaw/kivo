import { createHash, randomUUID } from 'node:crypto';
import type { KnowledgeFunction, KnowledgeNature, KnowledgeType } from '../types/index.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import {
  buildBehavioralChangeTestSection,
  buildHumanReadableIntentStyleSection,
  buildKnowledgeAdmissionBoundarySection,
} from '../standards/index.js';
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
6. 如果主题表达用户偏好、行为模式、意图映射或研发流程期望，nature 输出 "intent"，让它进入独立意图库。
7. 允许一批素材产出 0 条。宁缺毋滥。
8. 每条知识必须回答：它让 agent 在什么场景下避免什么错误。

${buildHumanReadableIntentStyleSection()}

## 输出约束
- title/content/why/similar_sentences 统一遵守上方「人话意图写作标准」。
- 禁止写「用户说」「这次」「当前」「刚才」「今天」「已完成」「正在」等对话过程词。
- nature：fact / decision / methodology / experience / intent / meta。
- function：constraint / preference / pattern / principle。
- domain：开放标签。
- materialIds：使用输入素材序号，如 [1,2]。

返回纯 JSON 数组：
[{"title":"提取知识时标题要像人说话一样具体","content":"具体场景下该做什么，不做会造成什么后果","why":"不这样做的后果、踩坑代价或失败模式；必须填写，无法可靠推断就丢弃该条","nature":"intent","function":"principle","domain":"","source":"session-aggregate","confidence":0.0,"tags":[""],"similar_sentences":["泛化表述1","泛化表述2"],"materialIds":[1,2]}]

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
