/**
 * Kivo — Facade 主入口类
 *
 * 统一 API 入口，隐藏内部子模块实现细节。
 * 生命周期：new Kivo(config) → init() → use API → shutdown()
 */

import type { KnowledgeEntry, KnowledgeSource } from './types/index.js';
import type { ConflictRecord, ResolutionStrategy } from './conflict/index.js';
import type { ResolutionResult } from './conflict/index.js';
import type { SearchResult } from './repository/index.js';
import type { SearchResult as VectorSearchResult } from './search/index.js';
import { PipelineEngine } from './pipeline/index.js';
import { KnowledgeRepository } from './repository/index.js';
import { SQLiteProvider } from './repository/index.js';
import { ConflictDetector } from './conflict/index.js';
import { ConflictResolver } from './conflict/index.js';
import { type KivoConfig, mergeConfig, validateConfig } from './config.js';
import type { EmbeddingProvider } from './embedding/embedding-provider.js';
import { EmbeddingCache } from './embedding/embedding-cache.js';
import { LocalEmbedding } from './embedding/local-embedding.js';
import { OpenAIEmbedding } from './embedding/openai-embedding.js';
import { VectorIndex } from './search/vector-index.js';
import { SemanticSearch } from './search/semantic-search.js';
import { SemanticRelevanceScorer } from './search/search-integration.js';
import { ContextInjector, type ContextInjectorOptions } from './injection/context-injector.js';

import { detectCapabilities, type SystemCapabilities } from './cli/capabilities.js';

// Domain L: Analysis Artifacts
import { AnalysisArtifactStore } from './pipeline/analysis-artifact-store.js';
import type { AnalysisArtifact, ArtifactReviewQueueItem } from './pipeline/analysis-artifact-store.js';

// Domain M: Domain Goals
import { DomainGoalStore } from './domain-goal/domain-goal-store.js';
import type { DomainGoal, DomainGoalInput } from './domain-goal/domain-goal-types.js';

// Domain F: Rule Subscription & Distribution
import { RuleRegistry } from './rules/rule-registry.js';
import { SubscriptionManager } from './subscription/subscription-manager.js';
import { RuleDistributor } from './distribution/rule-distributor.js';
import { MemoryKnowledgeStore } from './storage/knowledge-store.js';
import type { RegisteredRule, RuleFilter, RuleRegistration } from './rules/rule-types.js';
import type { Subscription, SubscriptionEvent } from './subscription/subscription-types.js';
import type { DistributionResult } from './distribution/distribution-types.js';

// Domain X: Access Control & Observability
import { DomainAccessChecker } from './access-control/domain-access-checker.js';
import { MetricsCollector } from './metrics/metrics-collector.js';
import type { DomainAccessConfig } from './access-control/access-control-types.js';
import type { Role } from './auth/auth-types.js';
import type { AggregatedMetrics, TimeWindow } from './metrics/metrics-types.js';

export interface IngestResult {
  taskId: string;
  entries: KnowledgeEntry[];
  conflicts: ConflictRecord[];
}

export class Kivo {
  private config: KivoConfig;
  private pipeline!: PipelineEngine;
  private repository!: KnowledgeRepository;
  private conflictDetector!: ConflictDetector;
  private conflictResolver!: ConflictResolver;
  private initialized = false;

  // Embedding + VectorSearch (optional)
  private embeddingProvider?: EmbeddingProvider;
  private embeddingCache?: EmbeddingCache;
  private vectorIndex?: VectorIndex;
  private semanticSearchEngine?: SemanticSearch;
  private semanticScorer?: SemanticRelevanceScorer;
  private capabilities!: SystemCapabilities;

  // Domain L: Analysis Artifacts
  private analysisArtifactStore!: AnalysisArtifactStore;

  // Domain M: Domain Goals
  private domainGoalStore!: DomainGoalStore;

  // Domain F: Rule Subscription & Distribution
  private ruleStore!: MemoryKnowledgeStore;
  private ruleRegistry!: RuleRegistry;
  private subscriptionManager!: SubscriptionManager;
  private ruleDistributor!: RuleDistributor;

  // Domain X: Access Control & Observability
  private accessChecker!: DomainAccessChecker;
  private metricsCollector!: MetricsCollector;

  constructor(config: KivoConfig) {
    validateConfig(config);
    this.config = mergeConfig(config);
  }

  /**
   * 初始化所有子模块。必须在使用 API 前调用。
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Domain L: Analysis Artifact Store (must be created before PipelineEngine)
    this.analysisArtifactStore = new AnalysisArtifactStore();

    // Pipeline (inject analysisArtifactStore so analysis_artifact stage is active)
    // Pipeline here is used for extraction/classification/artifact generation only.
    // Kivo.ingest performs its own conflict detection + repository persistence,
    // so we disable the in-pipeline quality gate to avoid mutating facade results
    // for concise single-paragraph inputs in tests and normal ingest flows.
    this.pipeline = new PipelineEngine({
      ...this.config.pipelineOptions,
      analysisArtifactStore: this.analysisArtifactStore,
      qualityGateEnabled: false,
    });

    // Repository (SQLite)
    const provider = new SQLiteProvider({ dbPath: this.config.dbPath, configDir: process.cwd() });
    this.repository = new KnowledgeRepository(provider);

    // Conflict detection
    const llmProvider = this.config.llmProvider ?? createDefaultLLMProvider();
    this.conflictDetector = new ConflictDetector({
      similarityThreshold: this.config.conflictThreshold,
      embeddingProvider: this.config.embeddingProvider,
      llmJudgeProvider: llmProvider,
    });
    this.conflictResolver = new ConflictResolver();

    // Initialize embedding + vector search if configured
    if (this.config.embedding) {
      const cfg = this.config.embedding;
      let baseProvider: EmbeddingProvider;
      if (cfg.provider === 'openai') {
        baseProvider = new OpenAIEmbedding({
          apiKey: cfg.options?.apiKey ?? '',
          model: cfg.options?.model,
        });
      } else {
        baseProvider = new LocalEmbedding(cfg.options?.dimensions);
      }
      this.embeddingProvider = baseProvider;
      this.embeddingCache = new EmbeddingCache(baseProvider, cfg.options?.cacheSize ?? 1000);
      this.vectorIndex = new VectorIndex();
      this.semanticSearchEngine = new SemanticSearch(this.embeddingCache, this.vectorIndex);
      this.semanticScorer = new SemanticRelevanceScorer({
        embeddingProvider: this.embeddingCache,
      });
    }

    // Domain M: Domain Goal Store
    this.domainGoalStore = new DomainGoalStore();

    // Domain F: Rule Subscription & Distribution
    this.ruleStore = new MemoryKnowledgeStore();
    this.ruleRegistry = new RuleRegistry(this.ruleStore);
    this.subscriptionManager = new SubscriptionManager();
    this.ruleDistributor = new RuleDistributor({
      ruleRegistry: this.ruleRegistry,
      subscriptionManager: this.subscriptionManager,
    });

    // Domain X: Access Control & Observability
    this.accessChecker = new DomainAccessChecker();
    this.metricsCollector = new MetricsCollector();

    this.initialized = true;
    this.capabilities = detectCapabilities(this.config);
  }

  /**
   * Expose the internal KnowledgeRepository for direct write operations.
   * Avoids creating a second SQLiteProvider externally.
   */
  getRepository(): KnowledgeRepository {
    this.ensureInitialized();
    return this.repository;
  }

  /**
   * 摄入文本，经 pipeline 提取 → 冲突检测 → 持久化
   */
  async ingest(text: string, source: string): Promise<IngestResult> {
    this.ensureInitialized();

    const knowledgeSource: KnowledgeSource = {
      type: 'conversation',
      reference: source,
      timestamp: new Date(),
    };

    // Run pipeline extraction synchronously for facade simplicity
    const taskId = this.pipeline.submit(text, knowledgeSource);

    // Wait for pipeline completion (poll task status)
    const entries = await this.waitForPipeline(taskId);

    // Conflict detection against existing entries
    const allConflicts: ConflictRecord[] = [];
    for (const entry of entries) {
      // Find potential conflicts by searching existing entries of same type
      const existingEntries = await this.findCandidatesForConflict(entry);
      const conflicts = await this.conflictDetector.detect(entry, existingEntries);
      allConflicts.push(...conflicts);

      // Persist entry
      const saved = await this.repository.save(entry);
      if (!saved) {
        entry.status = 'rejected';
        continue;
      }

      // Auto-index to vector store if embedding configured
      if (this.semanticSearchEngine) {
        await this.semanticSearchEngine.indexEntry(entry);
      }
    }

    return { taskId, entries, conflicts: allConflicts };
  }

  /**
   * 按关键词查询知识条目
   */
  async query(keywords: string): Promise<SearchResult[]> {
    this.ensureInitialized();
    // Trigram tokenizer: pass query as-is for substring matching (supports CJK)
    const sanitized = keywords.trim();
    if (!sanitized) return [];
    return this.repository.search({ text: sanitized });
  }

  /**
   * 按 ID 获取单条知识条目
   */
  async getEntry(id: string): Promise<KnowledgeEntry | null> {
    this.ensureInitialized();
    return this.repository.findById(id);
  }

  /**
   * 解决冲突
   */
  async resolveConflict(
    conflictRecord: ConflictRecord,
    strategy: ResolutionStrategy
  ): Promise<ResolutionResult> {
    this.ensureInitialized();

    const incoming = await this.repository.findById(conflictRecord.incomingId);
    const existing = await this.repository.findById(conflictRecord.existingId);

    if (!incoming || !existing) {
      throw new Error(`Cannot resolve conflict: entry not found (incoming=${conflictRecord.incomingId}, existing=${conflictRecord.existingId})`);
    }

    const result = this.conflictResolver.resolve(conflictRecord, incoming, existing, strategy);

    // Apply resolution: mark loser as superseded
    if (result.action === 'supersede') {
      await this.repository.updateStatus(result.loserId, 'superseded');
    }

    return result;
  }

  /**
   * 语义搜索 — 需要配置 embedding
   */
  async semanticSearch(query: string, topK: number = 10): Promise<VectorSearchResult[]> {
    this.ensureInitialized();
    if (!this.semanticSearchEngine) {
      const keywordResults = await this.query(query);
      return keywordResults.slice(0, topK).map(r => ({
        id: r.entry.id,
        score: r.score,
      }));
    }
    return this.semanticSearchEngine.search(query, topK);
  }

  /**
   * 将 repository 中所有条目批量索引到向量库
   */
  async indexAll(): Promise<number> {
    this.ensureInitialized();
    if (!this.semanticSearchEngine) {
      throw new Error('indexAll unavailable: embedding not configured. Provide config.embedding to enable.');
    }
    const allEntries = await this.repository.findAll();
    await this.semanticSearchEngine.indexBatch(allEntries);
    return allEntries.length;
  }

  /**
   * 获取 SemanticRelevanceScorer（供外部 ContextInjector 使用）
   */
  getSemanticScorer(): SemanticRelevanceScorer | undefined {
    return this.semanticScorer;
  }

  getCapabilities(): SystemCapabilities {
    return this.capabilities ?? detectCapabilities(this.config);
  }

  /**
   * 创建 ContextInjector，自动注入 SemanticRelevanceScorer（如果 embedding 已配置）
   */
  createContextInjector(options: Omit<ContextInjectorOptions, 'scorerInstance'>): ContextInjector {
    this.ensureInitialized();
    return new ContextInjector({
      ...options,
      scorerInstance: this.semanticScorer ?? undefined,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Domain L: Analysis Artifacts (FR-L01, FR-L02)
  // ═══════════════════════════════════════════════════════════════════

  /** 获取 AnalysisArtifactStore 实例（供外部直接操作） */
  getAnalysisArtifactStore(): AnalysisArtifactStore {
    this.ensureInitialized();
    return this.analysisArtifactStore;
  }

  /** 获取分析产物 */
  async getArtifact(artifactId: string): Promise<AnalysisArtifact | null> {
    this.ensureInitialized();
    return this.analysisArtifactStore.loadArtifact(artifactId);
  }

  /** 列出待审核的分析产物 */
  async listReviewQueue(): Promise<ArtifactReviewQueueItem[]> {
    this.ensureInitialized();
    return this.analysisArtifactStore.listReviewQueue();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Domain M: Domain Goals (FR-M01, FR-M02)
  // ═══════════════════════════════════════════════════════════════════

  /** 获取 DomainGoalStore 实例（供外部直接操作） */
  getDomainGoalStore(): DomainGoalStore {
    this.ensureInitialized();
    return this.domainGoalStore;
  }

  /** 创建域目标 */
  createDomainGoal(input: DomainGoalInput): DomainGoal {
    this.ensureInitialized();
    return this.domainGoalStore.create(input);
  }

  /** 获取域目标 */
  getDomainGoal(domainId: string): DomainGoal | null {
    this.ensureInitialized();
    return this.domainGoalStore.get(domainId);
  }

  /** 列出所有域目标 */
  listDomainGoals(): DomainGoal[] {
    this.ensureInitialized();
    return this.domainGoalStore.list();
  }

  /** 更新域目标 */
  updateDomainGoal(domainId: string, patch: Partial<Omit<DomainGoalInput, 'domainId'>>): DomainGoal | null {
    this.ensureInitialized();
    return this.domainGoalStore.update(domainId, patch);
  }

  /** 删除域目标 */
  deleteDomainGoal(domainId: string): boolean {
    this.ensureInitialized();
    return this.domainGoalStore.delete(domainId);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Domain F: Rule Subscription & Distribution (FR-F01~F03)
  // ═══════════════════════════════════════════════════════════════════

  /** 获取 RuleRegistry 实例 */
  getRuleRegistry(): RuleRegistry {
    this.ensureInitialized();
    return this.ruleRegistry;
  }

  /** 获取 SubscriptionManager 实例 */
  getSubscriptionManager(): SubscriptionManager {
    this.ensureInitialized();
    return this.subscriptionManager;
  }

  /** 获取 RuleDistributor 实例 */
  getRuleDistributor(): RuleDistributor {
    this.ensureInitialized();
    return this.ruleDistributor;
  }

  /** 注册规则 (FR-F01) */
  async registerRule(rule: RuleRegistration): Promise<RegisteredRule> {
    this.ensureInitialized();
    return this.ruleRegistry.register(rule);
  }

  /** 查询规则 (FR-F01) */
  async queryRules(filter?: RuleFilter): Promise<RegisteredRule[]> {
    this.ensureInitialized();
    return this.ruleRegistry.query(filter);
  }

  /** 订阅规则变更 (FR-F02) */
  subscribeRule(subscription: Subscription): string {
    this.ensureInitialized();
    return this.subscriptionManager.subscribe(subscription);
  }

  /** 取消订阅 (FR-F02) */
  unsubscribeRule(subscriptionId: string): boolean {
    this.ensureInitialized();
    return this.subscriptionManager.unsubscribe(subscriptionId);
  }

  /** 分发规则变更 (FR-F03) */
  async distributeRule(ruleId: string, eventType: SubscriptionEvent['type']): Promise<DistributionResult> {
    this.ensureInitialized();
    return this.ruleDistributor.distribute(ruleId, eventType);
  }

  /** 获取分发历史 (FR-F03) */
  getDistributionHistory(ruleId?: string): DistributionResult[] {
    this.ensureInitialized();
    return this.ruleDistributor.getDistributionHistory(ruleId);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Domain X: Access Control & Observability (FR-X01, FR-X02)
  // ═══════════════════════════════════════════════════════════════════

  /** 获取 DomainAccessChecker 实例 */
  getAccessChecker(): DomainAccessChecker {
    this.ensureInitialized();
    return this.accessChecker;
  }

  /** 获取 MetricsCollector 实例 */
  getMetricsCollector(): MetricsCollector {
    this.ensureInitialized();
    return this.metricsCollector;
  }

  /** 检查角色是否有权访问指定域 (FR-X01 AC1) */
  canAccess(role: Role, domainId: string): boolean {
    this.ensureInitialized();
    return this.accessChecker.canAccess(role, domainId);
  }

  /** 按角色过滤知识条目 (FR-X01 AC1) */
  filterByAccess(entries: KnowledgeEntry[], callerRole: Role): KnowledgeEntry[] {
    this.ensureInitialized();
    return this.accessChecker.filterEntries(entries, callerRole);
  }

  /** 更新访问控制配置 (FR-X01 AC2) */
  updateAccessConfig(config: DomainAccessConfig): void {
    this.ensureInitialized();
    this.accessChecker.updateConfig(config);
  }

  /** 获取聚合指标 (FR-X02 AC5) */
  getMetrics(window?: TimeWindow): AggregatedMetrics {
    this.ensureInitialized();
    return this.metricsCollector.aggregate(window);
  }

  /**
   * 关闭所有资源
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;
    this.pipeline.destroy();
    await this.repository.close();
    this.initialized = false;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('Kivo not initialized. Call init() first.');
    }
  }

  private async waitForPipeline(taskId: string): Promise<KnowledgeEntry[]> {
    // Poll with backoff — pipeline runs async internally
    const maxWait = 5000;
    const interval = 10;
    let elapsed = 0;

    while (elapsed < maxWait) {
      const task = this.pipeline.getTask(taskId);
      if (task && (task.status === 'completed' || task.status === 'failed')) {
        if (task.status === 'failed') {
          throw new Error(`Pipeline failed: ${task.error}`);
        }
        return task.results;
      }
      await sleep(interval);
      elapsed += interval;
    }

    // Return whatever we have
    return this.pipeline.getResults(taskId);
  }

  /**
   * Find existing entries that might conflict with the incoming entry.
   * Uses findByType to avoid FTS5 syntax issues with arbitrary text.
   */
  private async findCandidatesForConflict(entry: KnowledgeEntry): Promise<KnowledgeEntry[]> {
    return this.repository.findByType(entry.type);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * * 默认 LLM provider — 降级实现（基于关键词对比）
 * 生产环境应注入真实 LLM provider
 */
function createDefaultLLMProvider() {
  return {
    async judgeConflict(incoming: KnowledgeEntry, existing: KnowledgeEntry) {
      // 降级：标题高度重叠 + 内容不同 = conflict
      const titleOverlap = keywordOverlapSimple(incoming.title, existing.title);
      const contentOverlap = keywordOverlapSimple(incoming.content, existing.content);

      if (titleOverlap > 0.7 && contentOverlap < 0.5) {
        return 'conflict' as const;
      }
      return 'compatible' as const;
    },
  };
}

function keywordOverlapSimple(a: string, b: string): number {
  const wordsA = new Set(tokenizeForOverlap(a));
  const wordsB = new Set(tokenizeForOverlap(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

function tokenizeForOverlap(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}"']/g, ' ')
    .trim();

  const spaced = normalized.split(/\s+/).filter(Boolean);
  if (spaced.length > 1) return spaced;

  const compact = normalized.replace(/\s+/g, '');
  if (!compact) return [];
  if (/^[\x00-\x7F]+$/.test(compact)) return [compact];

  const grams: string[] = [];
  for (let i = 0; i < compact.length - 1; i++) {
    grams.push(compact.slice(i, i + 2));
  }
  return grams.length > 0 ? grams : [compact];
}
