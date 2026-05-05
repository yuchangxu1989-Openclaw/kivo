/**
 * IntentGovernanceEngine — FR-E06 意图知识治理核心引擎
 *
 * AC1: 定时扫描 + 语义聚类 → 识别高频主题
 * AC2: 高频主题自动提升权重
 * AC3: 语义重复自动合并（正例/负例并集，内容取最完整版本）
 * AC4: 长期未触发权重衰减 + pending_cleanup
 * AC5: 治理报告生成
 * AC6: 参数可配置
 * AC7: 操作可回退
 */

import type {
  GovernanceConfig,
  GovernableIntent,
  GovernanceStore,
  GovernanceReport,
  IntentCluster,
  MergeOperation,
  WeightChangeRecord,
} from './governance-types.js';
import { DEFAULT_GOVERNANCE_CONFIG } from './governance-types.js';

export class IntentGovernanceEngine {
  private config: GovernanceConfig;
  private store: GovernanceStore;

  constructor(store: GovernanceStore, config?: Partial<GovernanceConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_GOVERNANCE_CONFIG, ...config };
  }

  /** AC6: 运行时热更新配置 */
  updateConfig(patch: Partial<GovernanceConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  getConfig(): GovernanceConfig {
    return { ...this.config };
  }

  /**
   * 执行一轮完整治理（AC1-AC5）
   */
  async runGovernance(): Promise<GovernanceReport> {
    const intents = await this.store.listActive();
    const now = new Date();

    // AC1: 语义聚类
    const clusters = this.clusterIntents(intents);
    const highFreqClusters = clusters.filter(
      c => c.memberIds.length >= this.config.highFrequencyMinCount,
    );

    // AC2: 高频主题权重提升
    const weightChanges: WeightChangeRecord[] = [];
    const boostedIds = new Set<string>();
    for (const cluster of highFreqClusters) {
      for (const id of cluster.memberIds) {
        const intent = intents.find(i => i.id === id);
        if (!intent) continue;
        const prevWeight = intent.weight;
        const boost = this.config.boostCoefficient * cluster.memberIds.length;
        intent.weight = Math.min(intent.weight + boost, this.config.weightCap);
        if (intent.weight !== prevWeight) {
          boostedIds.add(id);
          weightChanges.push({
            intentId: id,
            previousWeight: prevWeight,
            newWeight: intent.weight,
            reason: 'boost',
            changedAt: now,
          });
        }
      }
    }

    // AC3: 语义重复合并
    const mergeOps: MergeOperation[] = [];
    const mergedAwayIds = new Set<string>();
    for (const cluster of clusters) {
      if (cluster.memberIds.length < 2) continue;
      if (cluster.avgSimilarity < this.config.similarityThreshold) continue;

      // 找出聚类中尚未被合并的意图
      const activeMembers = cluster.memberIds
        .filter(id => !mergedAwayIds.has(id))
        .map(id => intents.find(i => i.id === id))
        .filter((i): i is GovernableIntent => !!i);

      if (activeMembers.length < 2) continue;

      const merged = this.mergeIntents(activeMembers, now);
      const created = await this.store.create(merged);

      const op: MergeOperation = {
        id: `merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        resultId: created.id,
        sourceSnapshots: activeMembers.map(i => ({ ...i })),
        mergedAt: now,
        reverted: false,
      };
      mergeOps.push(op);
      await this.store.saveMergeOperation(op);

      // 标记原始意图为 merged
      for (const member of activeMembers) {
        member.governanceStatus = 'merged';
        mergedAwayIds.add(member.id);
      }
    }

    // AC4: 权重衰减
    const decayThreshold = new Date(now.getTime() - this.config.decayTriggerDays * 86400000);
    let pendingCleanupCount = 0;
    for (const intent of intents) {
      if (mergedAwayIds.has(intent.id)) continue;
      if (intent.governanceStatus !== 'active') continue;

      const lastHit = intent.lastHitAt;
      if (lastHit && lastHit < decayThreshold) {
        const prevWeight = intent.weight;
        intent.weight = Math.max(intent.weight * this.config.decayFactor, 0);
        if (intent.weight !== prevWeight) {
          weightChanges.push({
            intentId: intent.id,
            previousWeight: prevWeight,
            newWeight: intent.weight,
            reason: 'decay',
            changedAt: now,
          });
        }
        if (intent.weight < this.config.cleanupThreshold) {
          intent.governanceStatus = 'pending_cleanup';
          pendingCleanupCount++;
        }
      } else if (!lastHit && intent.createdAt < decayThreshold) {
        // 从未命中且创建时间超过衰减窗口
        const prevWeight = intent.weight;
        intent.weight = Math.max(intent.weight * this.config.decayFactor, 0);
        if (intent.weight !== prevWeight) {
          weightChanges.push({
            intentId: intent.id,
            previousWeight: prevWeight,
            newWeight: intent.weight,
            reason: 'decay',
            changedAt: now,
          });
        }
        if (intent.weight < this.config.cleanupThreshold) {
          intent.governanceStatus = 'pending_cleanup';
          pendingCleanupCount++;
        }
      }
    }

    // 批量持久化变更
    await this.store.updateMany(intents);

    // AC5: 生成治理报告
    const report: GovernanceReport = {
      id: `gov-${Date.now()}`,
      runAt: now,
      config: { ...this.config },
      highFrequencyThemesFound: highFreqClusters.length,
      mergedCount: mergeOps.reduce((sum, op) => sum + op.sourceSnapshots.length, 0),
      boostedCount: boostedIds.size,
      decayedCount: weightChanges.filter(w => w.reason === 'decay').length,
      pendingCleanupCount,
      clusters,
      mergeOperations: mergeOps,
      weightChanges,
    };

    await this.store.saveReport(report);
    return report;
  }

  /**
   * AC1: 语义聚类 — 基于文本相似度的简单聚类
   *
   * 使用 Jaccard 相似度对意图的 name + description + positives 进行聚类。
   * 生产环境可替换为 embedding 向量聚类。
   */
  clusterIntents(intents: GovernableIntent[]): IntentCluster[] {
    if (intents.length === 0) return [];

    const assigned = new Set<string>();
    const clusters: IntentCluster[] = [];

    for (let i = 0; i < intents.length; i++) {
      if (assigned.has(intents[i].id)) continue;

      const cluster: string[] = [intents[i].id];
      assigned.add(intents[i].id);
      let totalSim = 0;
      let pairCount = 0;

      for (let j = i + 1; j < intents.length; j++) {
        if (assigned.has(intents[j].id)) continue;
        const sim = this.computeSimilarity(intents[i], intents[j]);
        if (sim >= this.config.similarityThreshold) {
          cluster.push(intents[j].id);
          assigned.add(intents[j].id);
          totalSim += sim;
          pairCount++;
        }
      }

      clusters.push({
        centroidId: intents[i].id,
        memberIds: cluster,
        theme: intents[i].name,
        avgSimilarity: pairCount > 0 ? totalSim / pairCount : 1.0,
      });
    }

    return clusters;
  }

  /**
   * 计算两个意图之间的文本相似度（Jaccard）
   */
  computeSimilarity(a: GovernableIntent, b: GovernableIntent): number {
    const tokensA = this.tokenize(a);
    const tokensB = this.tokenize(b);
    if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersection = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) intersection++;
    }
    const union = tokensA.size + tokensB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private tokenize(intent: GovernableIntent): Set<string> {
    const text = [
      intent.name,
      intent.description,
      ...intent.positives,
    ].join(' ').toLowerCase();
    // 简单分词：按非字母数字字符和中文字符边界分割
    const tokens = text.match(/[\u4e00-\u9fff]+|[a-z0-9]+/g) ?? [];
    return new Set(tokens);
  }

  /**
   * AC3: 合并多个意图为一个
   * 策略：正例/负例取并集，内容取最长版本，来源引用全部保留
   */
  private mergeIntents(intents: GovernableIntent[], now: Date): GovernableIntent {
    // 取内容最完整的版本作为基础
    const base = intents.reduce((longest, current) =>
      (current.description.length + current.positives.join('').length) >
      (longest.description.length + longest.positives.join('').length)
        ? current
        : longest,
    );

    // 正例/负例取并集
    const allPositives = new Set<string>();
    const allNegatives = new Set<string>();
    const allLinkedIds = new Set<string>();
    let maxWeight = 0;

    for (const intent of intents) {
      for (const p of intent.positives) allPositives.add(p);
      for (const n of intent.negatives) allNegatives.add(n);
      for (const id of intent.linkedEntryIds) allLinkedIds.add(id);
      if (intent.weight > maxWeight) maxWeight = intent.weight;
    }

    return {
      id: `merged-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: base.name,
      description: base.description,
      positives: [...allPositives],
      negatives: [...allNegatives],
      linkedEntryIds: [...allLinkedIds],
      weight: maxWeight,
      lastHitAt: intents.reduce<Date | null>((latest, i) => {
        if (!i.lastHitAt) return latest;
        if (!latest) return i.lastHitAt;
        return i.lastHitAt > latest ? i.lastHitAt : latest;
      }, null),
      governanceStatus: 'active',
      mergedFromIds: intents.map(i => i.id),
      createdAt: now,
    };
  }

  /**
   * AC7: 回退合并操作
   */
  async revertMerge(mergeOperationId: string): Promise<boolean> {
    const op = await this.store.getMergeOperation(mergeOperationId);
    if (!op || op.reverted) return false;

    // 恢复原始意图
    for (const snapshot of op.sourceSnapshots) {
      snapshot.governanceStatus = 'active';
      await this.store.update(snapshot);
    }

    // 标记合并产物为 merged（失效）
    const merged = (await this.store.listActive()).find(i => i.id === op.resultId);
    if (merged) {
      merged.governanceStatus = 'merged';
      await this.store.update(merged);
    }

    op.reverted = true;
    await this.store.saveMergeOperation(op);
    return true;
  }

  /**
   * AC7: 手动覆盖权重
   */
  async overrideWeight(intentId: string, newWeight: number): Promise<void> {
    const intents = await this.store.listActive();
    const intent = intents.find(i => i.id === intentId);
    if (!intent) return;
    intent.weight = Math.min(Math.max(newWeight, 0), this.config.weightCap);
    await this.store.update(intent);
  }

  /**
   * AC7: 撤销 pending_cleanup 标记
   */
  async cancelCleanup(intentId: string): Promise<boolean> {
    const intents = await this.store.listActive();
    // Also check pending_cleanup intents
    const all = await this.store.listActive();
    const intent = all.find(i => i.id === intentId);
    if (!intent || intent.governanceStatus !== 'pending_cleanup') return false;
    intent.governanceStatus = 'active';
    intent.weight = Math.max(intent.weight, this.config.cleanupThreshold);
    await this.store.update(intent);
    return true;
  }
}
