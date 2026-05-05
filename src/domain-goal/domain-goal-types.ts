/**
 * Domain Goal Types — 域目标配置数据结构
 *
 * FR-M01: 域目标声明字段定义
 */

export interface DomainGoal {
  /** 知识域 ID */
  domainId: string;
  /** 目标描述 */
  purpose: string;
  /** 关键问题列表 */
  keyQuestions: string[];
  /** 非目标列表 */
  nonGoals: string[];
  /** 研究边界描述 */
  researchBoundary: string;
  /** 高优先级信号列表 */
  prioritySignals: string[];
  /** 创建时间 */
  createdAt: Date;
  /** 更新时间 */
  updatedAt: Date;
}

export interface DomainGoalInput {
  domainId: string;
  purpose: string;
  keyQuestions?: string[];
  nonGoals?: string[];
  researchBoundary?: string;
  prioritySignals?: string[];
}

export type DomainGoalChangeType = 'created' | 'updated' | 'deleted';

export interface DomainGoalChangeEvent {
  type: DomainGoalChangeType;
  domainId: string;
  timestamp: Date;
  previous?: DomainGoal;
  current?: DomainGoal;
}

export type DomainGoalChangeListener = (event: DomainGoalChangeEvent) => void;
