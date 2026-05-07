import { randomUUID } from 'node:crypto';
import type { KnowledgeType } from '../types/index.js';
import type { FrequencyBlindSpot, GapDetectionResult, GraphGap, KnowledgeGap, StructuralGap } from './gap-detection-types.js';
import type { ResearchTask, ResearchBudget, ResearchScope, ResearchStep, ResearchStrategy } from './research-task-types.js';

const PRIORITY_IMPACT_SCORE = {
  high: 3,
  medium: 2,
  low: 1,
} as const;

const DEFAULT_BUDGET: Record<KnowledgeGap['priority'], ResearchBudget> = {
  high: {
    maxDurationMs: 10 * 60 * 1000,
    maxApiCalls: 12,
  },
  medium: {
    maxDurationMs: 6 * 60 * 1000,
    maxApiCalls: 8,
  },
  low: {
    maxDurationMs: 3 * 60 * 1000,
    maxApiCalls: 4,
  },
};

const STRUCTURAL_CHAIN: KnowledgeType[] = ['fact', 'methodology', 'experience'];

export interface ResearchTaskGeneratorOptions {
  now?: () => Date;
  idGenerator?: () => string;
  defaultBudget?: Partial<Record<KnowledgeGap['priority'], Partial<ResearchBudget>>>;
}

export class ResearchTaskGenerator {
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly defaultBudget: Record<KnowledgeGap['priority'], ResearchBudget>;

  constructor(options: ResearchTaskGeneratorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.defaultBudget = mergeBudgets(options.defaultBudget);
  }

  generate(result: GapDetectionResult): ResearchTask[] {
    return result.gaps
      .map((gap) => this.toTask(gap))
      .sort(compareResearchTasks);
  }

  generateFromGap(gap: KnowledgeGap): ResearchTask {
    return this.toTask(gap);
  }

  private toTask(gap: KnowledgeGap): ResearchTask {
    const createdAt = new Date(this.now());

    if (gap.type === 'frequency_blind_spot') {
      return this.toFrequencyTask(gap, createdAt);
    }

    if (gap.type === 'graph_gap') {
      return this.toGraphTask(gap, createdAt);
    }

    return this.toStructuralTask(gap, createdAt);
  }

  private toFrequencyTask(gap: KnowledgeGap, createdAt: Date): ResearchTask {
    const evidence = gap.evidence as FrequencyBlindSpot;
    const topic = evidence.pattern;
    const impactScore = impactFromMissCount(evidence.missCount);
    const urgencyScore = gap.priority === 'high' ? 3 : gap.priority === 'medium' ? 2 : 1;
    const blocking = gap.priority === 'high';

    const scope: ResearchScope = {
      topic,
      boundaries: [
        '聚焦最近未命中的查询主题，不扩展到无关相邻概念。',
        '优先找能直接回答 Agent 查询的问题定义、操作步骤和踩坑经验。',
      ],
      acquisitionMethods: ['web_search', 'document_read'],
    };

    const steps: ResearchStep[] = [
      {
        id: `${gap.id}-step-web`,
        method: 'web_search',
        query: topic,
        rationale: '先用网页搜索快速拉齐该主题的一手定义和近期上下文。',
        limit: Math.min(6, Math.max(3, evidence.missCount)),
      },
      {
        id: `${gap.id}-step-doc`,
        method: 'document_read',
        query: `${topic} official documentation`,
        rationale: '补齐权威文档里的操作说明和约束条件。',
        limit: 2,
      },
    ];

    const strategy: ResearchStrategy = {
      steps,
      searchQueries: [topic, `${topic} guide`, `${topic} troubleshooting`],
      notes: '先覆盖事实和方法，再沉淀可执行经验，避免泛泛而谈。',
    };

    return {
      id: this.idGenerator(),
      gapId: gap.id,
      gapType: gap.type,
      title: `调研：${topic}`,
      objective: `补齐主题“${topic}”的高频查询盲区，让 Agent 能直接回答相近问题。`,
      scope,
      expectedKnowledgeTypes: ['fact', 'methodology', 'experience'],
      strategy,
      completionCriteria: [
        '至少形成 2 条可检索知识，其中包含事实和方法论。',
        '知识内容能覆盖最近高频未命中的核心问题。',
        '入库条目保留来源引用，支持后续溯源。',
      ],
      budget: cloneBudget(this.defaultBudget[gap.priority]),
      priority: gap.priority,
      impactScore,
      urgencyScore,
      blocking,
      createdAt,
    };
  }

  private toStructuralTask(gap: KnowledgeGap, createdAt: Date): ResearchTask {
    const evidence = gap.evidence as StructuralGap;
    const impactScore = PRIORITY_IMPACT_SCORE[gap.priority];
    const urgencyScore = Math.min(3, evidence.missingTypes.length + (gap.priority === 'high' ? 1 : 0));
    const blocking = evidence.missingTypes.length >= 2;
    const missingTypeLabels = evidence.missingTypes.join('、');

    const methods = evidence.missingTypes.includes('experience')
      ? (['document_read', 'web_search'] as const)
      : (['document_read', 'paper_parse'] as const);

    const steps: ResearchStep[] = [
      {
        id: `${gap.id}-step-doc`,
        method: 'document_read',
        query: `${evidence.domain} ${missingTypeLabels}`,
        rationale: '先读文档和体系化资料，确认这个领域当前缺失的知识骨架。',
        limit: 3,
      },
      {
        id: `${gap.id}-step-deep`,
        method: methods[1],
        query: `${evidence.domain} ${missingTypeLabels} best practices`,
        rationale: methods[1] === 'paper_parse'
          ? '补齐概念和方法之间的理论依据。'
          : '补齐实践经验和可执行案例。',
        limit: 2,
      },
    ];

    const strategy: ResearchStrategy = {
      steps,
      searchQueries: [
        `${evidence.domain} fundamentals`,
        `${evidence.domain} ${missingTypeLabels}`,
        `${evidence.domain} case study`,
      ],
      notes: '围绕领域知识链补洞，新增内容要能和现有条目建立关联。',
    };

    return {
      id: this.idGenerator(),
      gapId: gap.id,
      gapType: gap.type,
      title: `调研：补齐 ${evidence.domain} 知识链`,
      objective: `补齐 ${evidence.domain} 领域缺失的 ${missingTypeLabels}，形成知识闭环。`,
      scope: {
        topic: `${evidence.domain} knowledge chain`,
        domain: evidence.domain,
        boundaries: [
          `只补 ${evidence.domain} 领域中缺失的 ${missingTypeLabels}。`,
          `新增内容需要和现有 ${evidence.presentTypes.join('、')} 条目建立关联。`,
        ],
        acquisitionMethods: [...methods],
      },
      expectedKnowledgeTypes: sortExpectedTypes(evidence.missingTypes),
      strategy,
      completionCriteria: [
        `至少新增 1 条 ${missingTypeLabels} 类型知识。`,
        '新增知识与同领域已有条目形成可追踪关联。',
        '入库结果能支撑后续检索和冲突治理。',
      ],
      budget: cloneBudget(this.defaultBudget[gap.priority]),
      priority: gap.priority,
      impactScore,
      urgencyScore,
      blocking,
      createdAt,
    };
  }

  private toGraphTask(gap: KnowledgeGap, createdAt: Date): ResearchTask {
    const evidence = gap.evidence as GraphGap;
    const impactScore = PRIORITY_IMPACT_SCORE[gap.priority];
    const urgencyScore = gap.priority === 'high' ? 3 : gap.priority === 'medium' ? 2 : 1;
    const blocking = false;

    const steps: ResearchStep[] = [
      {
        id: `${gap.id}-step-web`,
        method: 'web_search',
        query: evidence.description,
        rationale: '搜索与图谱缺口相关的知识，建立缺失的关联。',
        limit: 4,
      },
      {
        id: `${gap.id}-step-doc`,
        method: 'document_read',
        query: `${evidence.description} relationships`,
        rationale: '从文档中提取能建立知识关联的内容。',
        limit: 2,
      },
    ];

    const strategy: ResearchStrategy = {
      steps,
      searchQueries: [evidence.description],
      notes: '围绕图谱缺口补洞，新增内容要能和已有条目建立关联。',
    };

    return {
      id: this.idGenerator(),
      gapId: gap.id,
      gapType: gap.type,
      title: `调研：补齐图谱缺口`,
      objective: `补齐知识图谱中的${evidence.description}，增强知识间的关联和支撑关系。`,
      scope: {
        topic: evidence.description,
        boundaries: [
          '聚焦图谱缺口涉及的知识节点，不扩展到无关领域。',
          '新增内容必须能与已有条目建立可追踪关联。',
        ],
        acquisitionMethods: ['web_search', 'document_read'],
      },
      expectedKnowledgeTypes: ['fact', 'methodology', 'experience'],
      strategy,
      completionCriteria: [
        '至少新增 1 条能建立关联的知识条目。',
        '新增知识与已有条目形成可追踪关联。',
      ],
      budget: cloneBudget(this.defaultBudget[gap.priority]),
      priority: gap.priority,
      impactScore,
      urgencyScore,
      blocking,
      createdAt,
    };
  }
}

function sortExpectedTypes(types: KnowledgeType[]): KnowledgeType[] {
  return STRUCTURAL_CHAIN.filter((type) => types.includes(type));
}

function impactFromMissCount(missCount: number): number {
  if (missCount >= 6) {
    return 3;
  }
  if (missCount >= 3) {
    return 2;
  }
  return 1;
}

function compareResearchTasks(a: ResearchTask, b: ResearchTask): number {
  const scoreA = a.impactScore * a.urgencyScore;
  const scoreB = b.impactScore * b.urgencyScore;
  if (scoreB !== scoreA) {
    return scoreB - scoreA;
  }

  return a.createdAt.getTime() - b.createdAt.getTime();
}

function mergeBudgets(
  overrides?: Partial<Record<KnowledgeGap['priority'], Partial<ResearchBudget>>>,
): Record<KnowledgeGap['priority'], ResearchBudget> {
  return {
    high: { ...DEFAULT_BUDGET.high, ...(overrides?.high ?? {}) },
    medium: { ...DEFAULT_BUDGET.medium, ...(overrides?.medium ?? {}) },
    low: { ...DEFAULT_BUDGET.low, ...(overrides?.low ?? {}) },
  };
}

function cloneBudget(budget: ResearchBudget): ResearchBudget {
  return {
    maxDurationMs: budget.maxDurationMs,
    maxApiCalls: budget.maxApiCalls,
  };
}
