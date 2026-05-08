/**
 * KnowledgeRouter — 分类结果驱动的知识路由
 * FR-K02
 *
 * 根据分类结果（知识类型 + 置信度）决定后续处理路径：
 * - 不同知识类型可应用不同的冲突检测策略和入库规则
 * - 置信度低于阈值时标记为待人工确认，不自动进入后续管线阶段
 */

import type { KnowledgeEntry, KnowledgeType, KnowledgeCategory } from '../types/index.js';

/** 路由规则：按知识类型配置处理策略 */
export interface RoutingRule {
  /** 适用的知识类型 */
  type: KnowledgeType;
  /** 冲突检测策略 */
  conflictStrategy: 'strict' | 'relaxed' | 'skip';
  /** 入库规则 */
  persistenceRule: 'auto' | 'review_required' | 'skip';
  /** 该类型的置信度阈值覆盖（可选） */
  confidenceThreshold?: number;
}

/**
 * Category-based routing rule — routes entries by their KnowledgeCategory.
 * Inspired by Vibe-Trading's data-routing skill: a meta-router that
 * dispatches to the correct processing pipeline based on data type.
 */
export interface CategoryRoutingRule {
  /** The category this rule applies to */
  category: KnowledgeCategory;
  /** Pipeline to route to (extensible string, e.g. 'standard', 'deep-analysis', 'fast-index') */
  pipeline: string;
  /** Override conflict strategy for this category */
  conflictStrategy?: 'strict' | 'relaxed' | 'skip';
  /** Override persistence rule for this category */
  persistenceRule?: 'auto' | 'review_required' | 'skip';
  /** Priority weight for injection ordering (higher = injected first) */
  injectionPriority?: number;
}

/** 路由结果 */
export interface RoutingDecision {
  entry: KnowledgeEntry;
  conflictStrategy: 'strict' | 'relaxed' | 'skip';
  persistenceRule: 'auto' | 'review_required' | 'skip';
  requiresManualReview: boolean;
  reason?: string;
  /** Target pipeline determined by category routing (if category is set) */
  pipeline?: string;
  /** Injection priority from category rule */
  injectionPriority?: number;
}

/** 默认路由规则 */
const DEFAULT_RULES: RoutingRule[] = [
  { type: 'fact', conflictStrategy: 'strict', persistenceRule: 'auto' },
  { type: 'methodology', conflictStrategy: 'relaxed', persistenceRule: 'auto' },
  { type: 'decision', conflictStrategy: 'strict', persistenceRule: 'auto' },
  { type: 'experience', conflictStrategy: 'relaxed', persistenceRule: 'auto' },
  { type: 'intent', conflictStrategy: 'strict', persistenceRule: 'auto' },
  { type: 'meta', conflictStrategy: 'skip', persistenceRule: 'auto' },
];

/** Default category routing rules */
const DEFAULT_CATEGORY_RULES: CategoryRoutingRule[] = [
  { category: 'domain', pipeline: 'standard', conflictStrategy: 'strict', injectionPriority: 10 },
  { category: 'process', pipeline: 'standard', conflictStrategy: 'relaxed', injectionPriority: 8 },
  { category: 'reference', pipeline: 'fast-index', conflictStrategy: 'strict', injectionPriority: 9 },
  { category: 'analysis', pipeline: 'deep-analysis', conflictStrategy: 'relaxed', injectionPriority: 7 },
  { category: 'tool', pipeline: 'fast-index', conflictStrategy: 'skip', injectionPriority: 6 },
  { category: 'strategy', pipeline: 'deep-analysis', conflictStrategy: 'strict', injectionPriority: 8 },
  { category: 'experience', pipeline: 'standard', conflictStrategy: 'relaxed', injectionPriority: 5 },
  { category: 'meta', pipeline: 'fast-index', conflictStrategy: 'skip', injectionPriority: 3 },
];

export interface KnowledgeRouterOptions {
  /** 自定义路由规则（覆盖默认规则） */
  rules?: RoutingRule[];
  /** Category-based routing rules (override defaults) */
  categoryRules?: CategoryRoutingRule[];
  /** 全局置信度阈值，低于此值标记为待人工确认。默认 0.5 */
  confidenceThreshold?: number;
}

export class KnowledgeRouter {
  private readonly rules: Map<KnowledgeType, RoutingRule>;
  private readonly categoryRules: Map<KnowledgeCategory, CategoryRoutingRule>;
  private readonly confidenceThreshold: number;

  constructor(options: KnowledgeRouterOptions = {}) {
    this.confidenceThreshold = options.confidenceThreshold ?? 0.7;
    this.rules = new Map();
    this.categoryRules = new Map();

    // 先加载默认规则
    for (const rule of DEFAULT_RULES) {
      this.rules.set(rule.type, rule);
    }
    // 用户自定义规则覆盖
    if (options.rules) {
      for (const rule of options.rules) {
        this.rules.set(rule.type, rule);
      }
    }

    // Load default category rules
    for (const rule of DEFAULT_CATEGORY_RULES) {
      this.categoryRules.set(rule.category, rule);
    }
    // User overrides
    if (options.categoryRules) {
      for (const rule of options.categoryRules) {
        this.categoryRules.set(rule.category, rule);
      }
    }
  }

  /**
   * 为单个条目生成路由决策
   * FR-K02 AC2：分类结果决定后续处理路径
   * FR-K02 AC3：置信度低于阈值时标记为待人工确认
   */
  route(entry: KnowledgeEntry): RoutingDecision {
    const rule = this.rules.get(entry.type);
    const threshold = rule?.confidenceThreshold ?? this.confidenceThreshold;
    const requiresManualReview = entry.confidence < threshold;

    // Category-based routing: if entry has a category, apply category rule
    const catRule = entry.category ? this.categoryRules.get(entry.category) : undefined;

    // Determine conflict strategy: category rule overrides type rule if present
    const conflictStrategy = catRule?.conflictStrategy ?? rule?.conflictStrategy ?? 'strict';
    const basePersistence = catRule?.persistenceRule ?? rule?.persistenceRule ?? 'auto';
    const persistenceRule = requiresManualReview ? 'review_required' : basePersistence;

    if (!rule && !catRule) {
      return {
        entry,
        conflictStrategy: 'strict',
        persistenceRule: requiresManualReview ? 'review_required' : 'auto',
        requiresManualReview,
        reason: requiresManualReview
          ? `Confidence ${entry.confidence} below threshold ${threshold}`
          : undefined,
      };
    }

    return {
      entry,
      conflictStrategy,
      persistenceRule,
      requiresManualReview,
      reason: requiresManualReview
        ? `Confidence ${entry.confidence} below threshold ${threshold}`
        : undefined,
      pipeline: catRule?.pipeline,
      injectionPriority: catRule?.injectionPriority,
    };
  }

  /**
   * 批量路由
   */
  routeAll(entries: KnowledgeEntry[]): RoutingDecision[] {
    return entries.map(e => this.route(e));
  }

  /**
   * 按路由结果分组
   */
  partition(entries: KnowledgeEntry[]): {
    autoProcess: RoutingDecision[];
    manualReview: RoutingDecision[];
    skipConflict: RoutingDecision[];
  } {
    const decisions = this.routeAll(entries);
    return {
      autoProcess: decisions.filter(d => !d.requiresManualReview && d.conflictStrategy !== 'skip'),
      manualReview: decisions.filter(d => d.requiresManualReview),
      skipConflict: decisions.filter(d => !d.requiresManualReview && d.conflictStrategy === 'skip'),
    };
  }

  /**
   * 获取指定类型的路由规则
   */
  getRule(type: KnowledgeType): RoutingRule | undefined {
    return this.rules.get(type);
  }

  /**
   * 动态更新路由规则
   */
  updateRule(rule: RoutingRule): void {
    this.rules.set(rule.type, rule);
  }

  /**
   * Get category routing rule
   */
  getCategoryRule(category: KnowledgeCategory): CategoryRoutingRule | undefined {
    return this.categoryRules.get(category);
  }

  /**
   * Update or add a category routing rule
   */
  updateCategoryRule(rule: CategoryRoutingRule): void {
    this.categoryRules.set(rule.category, rule);
  }

  /**
   * Resolve the target pipeline for an entry based on its category.
   * Returns 'standard' if no category or no matching rule.
   */
  resolvePipeline(entry: KnowledgeEntry): string {
    if (!entry.category) return 'standard';
    const rule = this.categoryRules.get(entry.category);
    return rule?.pipeline ?? 'standard';
  }
}
