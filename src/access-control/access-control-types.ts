/**
 * Access Control Types — 知识域访问控制
 *
 * FR-X01:
 * - AC1: 条目归属域，检索按 callerRole 过滤
 * - AC2: 域-角色映射通过配置静态定义
 * - AC3: 规则分发遵循订阅范围约束
 * - AC4: 调研任务仅访问有权限的信息源
 */

import type { Role } from '../auth/auth-types.js';

export interface DomainAccessRule {
  domainId: string;
  allowedRoles: Role[];
}

export interface DomainAccessConfig {
  rules: DomainAccessRule[];
  /** 未配置的域默认策略: 'allow-all' 允许所有角色, 'deny' 拒绝 */
  defaultPolicy: 'allow-all' | 'deny';
}

export const DEFAULT_ACCESS_CONFIG: DomainAccessConfig = {
  rules: [],
  defaultPolicy: 'allow-all',
};
