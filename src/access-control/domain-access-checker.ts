/**
 * DomainAccessChecker — 知识域访问控制检查器
 *
 * FR-X01:
 * - AC1: 检索请求携带 callerRole，仅返回有权访问的域内条目
 * - AC2: 域-角色映射通过配置静态定义
 * - AC3: 规则分发遵循订阅范围约束
 * - AC4: 调研任务仅访问有权限的信息源
 */

import type { Role } from '../auth/auth-types.js';
import type { KnowledgeEntry } from '../types/index.js';
import type { DomainAccessConfig, DomainAccessRule } from './access-control-types.js';
import { DEFAULT_ACCESS_CONFIG } from './access-control-types.js';

export class DomainAccessChecker {
  private config: DomainAccessConfig;
  private ruleMap = new Map<string, DomainAccessRule>();

  constructor(config?: DomainAccessConfig) {
    this.config = config ?? DEFAULT_ACCESS_CONFIG;
    this.rebuildIndex();
  }

  /** 更新访问控制配置 */
  updateConfig(config: DomainAccessConfig): void {
    this.config = config;
    this.rebuildIndex();
  }

  /**
   * AC1: 检查角色是否有权访问指定域
   */
  canAccess(role: Role, domainId: string): boolean {
    const rule = this.ruleMap.get(domainId);
    if (!rule) {
      return this.config.defaultPolicy === 'allow-all';
    }
    return rule.allowedRoles.includes(role);
  }

  /**
   * AC1: 过滤知识条目，仅返回 callerRole 有权访问的域内条目
   */
  filterEntries(entries: KnowledgeEntry[], callerRole: Role): KnowledgeEntry[] {
    return entries.filter(entry => {
      const domain = entry.domain ?? 'default';
      return this.canAccess(callerRole, domain);
    });
  }

  /**
   * AC3: 获取角色可访问的域列表（用于规则分发范围约束）
   */
  getAccessibleDomains(role: Role): string[] {
    const accessible: string[] = [];
    for (const rule of this.config.rules) {
      if (rule.allowedRoles.includes(role)) {
        accessible.push(rule.domainId);
      }
    }
    // 如果默认策略是 allow-all，未配置的域也可访问
    if (this.config.defaultPolicy === 'allow-all') {
      accessible.push('*'); // wildcard 表示未配置的域
    }
    return accessible;
  }

  /**
   * AC4: 检查调研任务是否有权访问指定信息源域
   */
  canResearch(callerRole: Role, targetDomainId: string): boolean {
    return this.canAccess(callerRole, targetDomainId);
  }

  /** 获取当前配置 */
  getConfig(): DomainAccessConfig {
    return { ...this.config, rules: [...this.config.rules] };
  }

  /** 列出所有已配置的域规则 */
  listRules(): DomainAccessRule[] {
    return [...this.config.rules];
  }

  private rebuildIndex(): void {
    this.ruleMap.clear();
    for (const rule of this.config.rules) {
      this.ruleMap.set(rule.domainId, rule);
    }
  }
}
