/**
 * KIVO Engine Singleton — shared across all API routes.
 * Lazily initializes the Kivo instance on first access.
 */

import { Kivo, KnowledgeRepository, SQLiteProvider } from '@self-evolving-harness/kivo';
import type { KivoConfig, KnowledgeEntry } from '@self-evolving-harness/kivo';
import path from 'path';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');

const config: KivoConfig = {
  dbPath: DB_PATH,
  conflictThreshold: 0.7,
};

let instance: Kivo | null = null;
let seeded = false;

export async function getKivo(): Promise<Kivo> {
  if (!instance) {
    instance = new Kivo(config);
    await instance.init();
    if (!seeded) {
      seeded = true;
      await seedDemoData();
    }
  }
  return instance;
}

/**
 * Direct repository access for write operations not exposed by Kivo facade.
 * Reuses the Kivo internal repository — single SQLiteProvider instance.
 */
export async function getRepository(): Promise<KnowledgeRepository> {
  const kivo = await getKivo();
  return kivo.getRepository();
}

/**
 * Persist an updated entry directly to the repository.
 */
export async function persistEntry(entry: KnowledgeEntry): Promise<boolean> {
  const repo = await getRepository();
  return repo.save(entry);
}

/**
 * Seed demo data — called once on first init.
 * Inserts entries only if the repository is empty.
 */
async function seedDemoData(): Promise<void> {
  const seedRepo = new KnowledgeRepository(new SQLiteProvider({ dbPath: DB_PATH, configDir: process.cwd() }));
  const existing = await seedRepo.findAll();
  if (existing.length > 0) {
    await seedRepo.close();
    return;
  }

  const now = new Date();
  const d = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86400000);

  const entries: KnowledgeEntry[] = [
    {
      id: 'ke-001', type: 'decision',
      title: '需求→设计→实现三阶段流程作为默认研发管线',
      content: 'Specify → Plan → Implement 三阶段流程确定为所有新模块的默认研发管线。跳过需求分析直接编码的做法在早期导致了 3 次大规模返工，平均浪费 2 天。三阶段流程强制要求先产出需求规格和架构设计，再进入编码，从根本上减少返工。',
      summary: '确定三阶段为默认研发管线，禁止跳过需求分析直接编码',
      source: { type: 'conversation', reference: 'session:main:2026-04-15', timestamp: d(5), agent: 'sa-01' },
      confidence: 0.95, status: 'active',
      tags: ['architecture', 'process'], domain: '架构设计',
      createdAt: d(5), updatedAt: d(5), version: 1,
    },
    {
      id: 'ke-002', type: 'fact',
      title: '团队成员编码能力梯队排序',
      content: 'T1（最强）：高级工程师；T2：中级工程师；T3：初级工程师；T4：实习生。编码任务优先派 T1/T2，实习生适合轻量任务。此排序基于 2026 年 4 月的实测结果，高级工程师在复杂重构任务中成功率 92%，实习生仅 45%。',
      summary: '编码能力梯队：T1 高级 > T2 中级 > T3 初级 > T4 实习',
      source: { type: 'document', reference: 'docs/TEAM.md', timestamp: d(10), agent: 'main' },
      confidence: 0.9, status: 'active',
      tags: ['team', 'capability', 'routing'], domain: '团队协作',
      createdAt: d(10), updatedAt: d(3), version: 2,
    },
    {
      id: 'ke-003', type: 'methodology',
      title: '长文档分段式写作策略',
      content: '预估产出超过 300 行或 15KB 的文档任务，首次派发即分段。第一段输出目录和前半章节，确认文件写入成功后再派第二段续写。实测分段写文档 3 分钟完成 611 行，而整篇写 60 分钟超时失败。多人交叉写作可进一步提速。',
      summary: '长文档分段写作：首次即分段，避免整篇超时失败',
      source: { type: 'conversation', reference: 'session:main:2026-04-18', timestamp: d(2), agent: 'main' },
      confidence: 0.92, status: 'active',
      tags: ['methodology', 'writing', 'efficiency'], domain: '项目管理',
      createdAt: d(2), updatedAt: d(2), version: 1,
    },
    {
      id: 'ke-004', type: 'experience',
      title: '主线程阻塞导致请求丢失',
      content: '系统存在已知缺陷：主线程处理请求期间，新发的请求会被静默丢弃。首次发现时用户连续发了 3 条请求只收到 1 条回复。解决方案：主线程只做秒级响应，超过 30 秒的工作必须异步处理。',
      summary: '主线程阻塞时请求会被丢弃，必须保持主线程空闲',
      source: { type: 'conversation', reference: 'session:main:2026-04-12', timestamp: d(8), agent: 'main' },
      confidence: 0.98, status: 'active',
      tags: ['bug', 'performance', 'critical'], domain: '运维经验',
      createdAt: d(8), updatedAt: d(6), version: 2,
    },
    {
      id: 'ke-005', type: 'decision',
      title: '知识类型采用六分类体系',
      content: '知识条目分为 fact、methodology、decision、experience、intent、meta 六种类型。最初考虑过三分类（事实/决策/经验）和八分类方案，最终选择六分类：覆盖面足够广，又不至于分类困难。intent 类型用于捕获用户意图的正例和负例，meta 用于元认知层面的知识。',
      summary: '知识六分类：fact/methodology/decision/experience/intent/meta',
      source: { type: 'document', reference: 'docs/architecture/decisions/ADR-006.md', timestamp: d(12), agent: 'sa-01' },
      confidence: 0.95, status: 'active',
      tags: ['knowledge-model', 'core'], domain: '产品需求',
      createdAt: d(12), updatedAt: d(12), version: 1,
    },
    {
      id: 'ke-006', type: 'meta',
      title: '缓存压缩导致事实性信息不可靠',
      content: '会话 token 超限时会被压缩，一天可能压缩多次，每次压缩都有信息丢失。因此缓存中的数量、状态、是否存在、是否完成等事实性信息极不可靠。所有事实性判断必须先执行客观检查命令，缓存只能作为查证线索。这是一条元认知规则，适用于所有团队成员。',
      summary: '缓存不可信，事实性判断必须先查证再回答',
      source: { type: 'manual', reference: 'user:admin', timestamp: d(7), agent: 'main' },
      confidence: 1.0, status: 'active',
      tags: ['meta', 'reliability', 'rule'], domain: '团队协作',
      createdAt: d(7), updatedAt: d(7), version: 1,
    },
    {
      id: 'ke-007', type: 'experience',
      title: 'SQLite FTS5 语法错误导致搜索崩溃',
      content: '用户输入包含特殊字符（引号、括号、星号）时，直接拼入 FTS5 查询会导致 SQL 语法错误。修复方案：对每个搜索词用双引号包裹，并转义内部引号。query() 方法已修复，但 semanticSearch 的 fallback 路径仍需注意。',
      summary: 'FTS5 查询需转义特殊字符，避免语法错误',
      source: { type: 'conversation', reference: 'session:dev:2026-04-17', timestamp: d(3), agent: 'dev' },
      confidence: 0.88, status: 'active',
      tags: ['bug', 'sqlite', 'search'], domain: '运维经验',
      createdAt: d(3), updatedAt: d(3), version: 1,
    },
    {
      id: 'ke-008', type: 'fact',
      title: '研发管线包含 11 个内核细阶段',
      content: '研发管线的 11 个内核细阶段：spec → spec-review-gate → test-case-authoring → contract → contract-review-gate → implement → review → regression → deploy → verify → ledger。映射到 4 个用户宏阶段：specify/plan/implement/review。',
      summary: '11 细阶段映射到 4 宏阶段',
      source: { type: 'document', reference: 'docs/architecture/arc42-architecture.md', timestamp: d(6), agent: 'sa-01' },
      confidence: 0.95, status: 'active',
      tags: ['pipeline', 'stages'], domain: '产品需求',
      createdAt: d(6), updatedAt: d(4), version: 1,
    },
    {
      id: 'ke-009', type: 'methodology',
      title: '三方会审门禁机制',
      content: '架构设计完成后必须经过三方评审：产品经理（产品视角）、开发工程师（开发视角）、质量工程师（质量视角）。三方并行评审，各自产出评审报告。修复后的复审只需未通过方复审。三方全部通过后自动进入编码阶段。',
      summary: '架构三方会审：产品+开发+质量并行评审，全过即进编码',
      source: { type: 'conversation', reference: 'session:main:2026-04-16', timestamp: d(4), agent: 'main' },
      confidence: 0.93, status: 'active',
      tags: ['gate', 'review', 'process'], domain: '架构设计',
      createdAt: d(4), updatedAt: d(4), version: 1,
    },
    {
      id: 'ke-010', type: 'experience',
      title: '服务重启后端口占用需等待释放',
      content: '执行服务重启后，旧进程的端口可能需要 2-3 秒才能释放。如果立即 curl 验证会得到 ECONNREFUSED。建议 restart 后 sleep 3 再验证。',
      summary: '服务重启后需等待端口释放，建议 sleep 3 再验证',
      source: { type: 'conversation', reference: 'session:dev:2026-04-19', timestamp: d(1), agent: 'dev' },
      confidence: 0.85, status: 'active',
      tags: ['devops', 'tip'], domain: '运维经验',
      createdAt: d(1), updatedAt: d(1), version: 1,
    },
    {
      id: 'ke-011', type: 'intent',
      title: '用户偏好：先执行后汇报',
      content: '用户明确要求先执行后汇报，做完再说怎么做的。禁止一小步一汇报，查询类排查连续做完，只在拿到阶段性根因或关键结论时回报。',
      summary: '用户偏好先做后说，禁止逐步请示',
      source: { type: 'manual', reference: 'user:admin', timestamp: d(14), agent: 'main' },
      confidence: 1.0, status: 'active',
      tags: ['user-preference', 'workflow'], domain: '团队协作',
      createdAt: d(14), updatedAt: d(9), version: 2,
    },
    {
      id: 'ke-012', type: 'fact',
      title: '适配器模式是核心架构范式',
      content: '核心流程通用化设计，可在任意宿主环境运行。宿主特有能力通过 Adapter 接入增强，但核心流程不因缺少某个宿主而断裂。',
      summary: '适配器模式：核心通用 + 宿主能力通过 Adapter 接入',
      source: { type: 'document', reference: 'docs/architecture/arc42-architecture.md', timestamp: d(6), agent: 'sa-01' },
      confidence: 0.93, status: 'active',
      tags: ['architecture', 'pattern', 'adapter'], domain: '架构设计',
      createdAt: d(6), updatedAt: d(6), version: 1,
    },
  ];

  for (const entry of entries) {
    await seedRepo.save(entry, { skipQualityGate: true });
  }
  await seedRepo.close();
}
