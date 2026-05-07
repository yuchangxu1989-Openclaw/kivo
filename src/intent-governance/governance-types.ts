/**
 * Intent Governance Types — FR-E06
 *
 * AC1: 定时聚合分析（语义聚类，识别高频主题）
 * AC2: 高频主题自动提升注入优先级权重
 * AC3: 语义重复意图自动合并
 * AC4: 长期未触发意图权重衰减 + pending_cleanup 标记
 * AC5: 治理报告生成与持久化
 * AC6: 治理参数可配置，支持运行时热更新
 * AC7: 治理操作全部可回退
 */

/** AC6: 治理引擎配置 */
export interface GovernanceConfig {
  /** 扫描窗口天数（默认 7） */
  scanWindowDays: number;
  /** 语义相似度阈值（0-1，超过此值视为重复，默认 0.75） */
  similarityThreshold: number;
  /** 高频主题最低出现次数（默认 3） */
  highFrequencyMinCount: number;
  /** 权重提升系数（每次出现增加的权重，默认 0.1） */
  boostCoefficient: number;
  /** 权重上限（默认 2.0） */
  weightCap: number;
  /** 衰减触发天数（连续 N 天未命中，默认 30） */
  decayTriggerDays: number;
  /** 衰减系数（每次衰减乘以此值，默认 0.8） */
  decayFactor: number;
  /** 待清理阈值（权重低于此值标记 pending_cleanup，默认 0.2） */
  cleanupThreshold: number;
}

export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = {
  scanWindowDays: 7,
  similarityThreshold: 0.75,
  highFrequencyMinCount: 3,
  boostCoefficient: 0.1,
  weightCap: 2.0,
  decayTriggerDays: 30,
  decayFactor: 0.8,
  cleanupThreshold: 0.2,
};

/** 意图条目（含治理元数据） */
export interface GovernableIntent {
  id: string;
  name: string;
  description: string;
  positives: string[];
  negatives: string[];
  linkedEntryIds: string[];
  /** 注入优先级权重（默认 1.0） */
  weight: number;
  /** 最后一次命中注入的时间 */
  lastHitAt: Date | null;
  /** 状态：active / pending_cleanup / merged */
  governanceStatus: 'active' | 'pending_cleanup' | 'merged';
  /** 合并来源（如果是合并产物，记录原始 ID） */
  mergedFromIds?: string[];
  /** 创建时间 */
  createdAt: Date;
}

/** 聚类结果 */
export interface IntentCluster {
  /** 聚类中心意图 ID */
  centroidId: string;
  /** 聚类成员意图 ID */
  memberIds: string[];
  /** 聚类主题摘要 */
  theme: string;
  /** 聚类内平均相似度 */
  avgSimilarity: number;
}

/** 合并操作记录（AC7: 可回退） */
export interface MergeOperation {
  id: string;
  /** 合并产物 ID */
  resultId: string;
  /** 被合并的原始意图快照 */
  sourceSnapshots: GovernableIntent[];
  /** 合并时间 */
  mergedAt: Date;
  /** 是否已回退 */
  reverted: boolean;
}

/** 权重变更记录（AC7: 可回退） */
export interface WeightChangeRecord {
  intentId: string;
  previousWeight: number;
  newWeight: number;
  reason: 'boost' | 'decay' | 'manual';
  changedAt: Date;
}

/** AC5: 治理报告 */
export interface GovernanceReport {
  id: string;
  runAt: Date;
  config: GovernanceConfig;
  /** 新识别高频主题数 */
  highFrequencyThemesFound: number;
  /** 合并条目数 */
  mergedCount: number;
  /** 权重提升条目数 */
  boostedCount: number;
  /** 衰减条目数 */
  decayedCount: number;
  /** 标记待清理条目数 */
  pendingCleanupCount: number;
  /** 聚类详情 */
  clusters: IntentCluster[];
  /** 合并操作详情 */
  mergeOperations: MergeOperation[];
  /** 权重变更详情 */
  weightChanges: WeightChangeRecord[];
}

/** 治理引擎依赖的存储接口 */
export interface GovernanceStore {
  /** 获取所有活跃意图（含治理元数据） */
  listActive(): Promise<GovernableIntent[]>;
  /** 更新意图（含治理元数据） */
  update(intent: GovernableIntent): Promise<void>;
  /** 批量更新 */
  updateMany(intents: GovernableIntent[]): Promise<void>;
  /** 创建合并后的新意图 */
  create(intent: GovernableIntent): Promise<GovernableIntent>;
  /** 保存合并操作记录 */
  saveMergeOperation(op: MergeOperation): Promise<void>;
  /** 获取合并操作记录 */
  getMergeOperation(id: string): Promise<MergeOperation | null>;
  /** 保存治理报告 */
  saveReport(report: GovernanceReport): Promise<void>;
  /** 获取治理报告列表 */
  listReports(limit?: number): Promise<GovernanceReport[]>;
}
