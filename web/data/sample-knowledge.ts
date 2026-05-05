export type LocalKnowledgeType = 'fact' | 'decision' | 'methodology';

export interface LocalKnowledgeEntry {
  id: string;
  type: LocalKnowledgeType;
  title: string;
  content: string;
  summary: string;
  domain: string;
  status: 'active';
  confidence: number;
  source: {
    type: 'manual' | 'system';
    reference: string;
  };
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface LocalKnowledgeRelation {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'supports' | 'depends_on' | 'co_occurs';
  strength: number;
  signal: string;
}

const NOW = '2026-05-02T09:00:00.000+08:00';

export const sampleKnowledgeEntries: LocalKnowledgeEntry[] = [
  {
    id: 'sample-knowledge-001',
    type: 'decision',
    title: '首次入库先给用户一批可搜索的种子知识',
    content:
      'KIVO 的首用体验要先让用户在 5 分钟内看到真实可搜索的知识，而不是空页面。最短路径是先导入一批种子知识，再让用户去搜索、看图谱、看知识详情。',
    summary: '首用阶段先给用户可搜索的种子知识，避免空页面。',
    domain: 'onboarding',
    status: 'active',
    confidence: 0.96,
    source: { type: 'system', reference: 'KIVO 示例知识包 / 首次 Onboarding' },
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  },
  {
    id: 'sample-knowledge-002',
    type: 'methodology',
    title: '导入文档时先切片再抽取候选知识',
    content:
      '长文档直接整篇抽取容易漏掉上下文和边界，首轮导入应先按段落或章节切片，再对每段做候选知识抽取，最后进入人工确认。这样能同时提升覆盖率和可审查性。',
    summary: '文档导入先切片再抽取，候选知识更完整也更容易审核。',
    domain: 'import',
    status: 'active',
    confidence: 0.92,
    source: { type: 'system', reference: 'KIVO 示例知识包 / 导入方法论' },
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  },
  {
    id: 'sample-knowledge-003',
    type: 'fact',
    title: '冲突裁决页面只处理 unresolved 冲突',
    content:
      '冲突裁决页的核心工作是处理 unresolved 冲突。已经 resolved 的记录应该保留历史，但不占据用户的首屏注意力。这样用户能先把真正阻塞知识库健康度的问题处理完。',
    summary: '冲突页优先呈现 unresolved 冲突，已解决记录只保留历史。',
    domain: 'conflicts',
    status: 'active',
    confidence: 0.89,
    source: { type: 'system', reference: 'KIVO 示例知识包 / 冲突治理' },
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  },
  {
    id: 'sample-knowledge-004',
    type: 'decision',
    title: '新用户完成任意一次入库动作后结束 onboarding',
    content:
      '只要用户完成上传文档、导入示例数据或手动创建知识中的任意一个动作，就说明已经走通了第一次知识入库闭环。此时应标记 onboarding 完成，并把用户带到知识列表继续浏览。',
    summary: '任意一次成功入库动作即可结束 onboarding，并跳转到知识列表。',
    domain: 'onboarding',
    status: 'active',
    confidence: 0.97,
    source: { type: 'system', reference: 'KIVO 示例知识包 / 首用闭环规则' },
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  },
  {
    id: 'sample-knowledge-005',
    type: 'methodology',
    title: '首轮搜索先问规则名、异常场景或决策标题',
    content:
      '用户第一次使用搜索时，最容易命中的查询往往不是宽泛问题，而是规则名称、异常描述或决策标题。给出几个示例查询，可以显著降低首用成本并提升命中率感知。',
    summary: '首轮搜索优先使用规则名、异常描述和决策标题。',
    domain: 'search',
    status: 'active',
    confidence: 0.91,
    source: { type: 'system', reference: 'KIVO 示例知识包 / 搜索实践' },
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  },
  {
    id: 'sample-knowledge-006',
    type: 'fact',
    title: '图谱最适合展示 supports 和 depends_on 关系',
    content:
      '知识图谱在首用阶段最直观的价值，是把 supports 和 depends_on 关系画出来。用户能快速看到哪些方法论支撑了决策，哪些事实又依赖上游结论。',
    summary: '首用图谱重点展示 supports / depends_on 关系，便于快速理解结构。',
    domain: 'graph',
    status: 'active',
    confidence: 0.88,
    source: { type: 'system', reference: 'KIVO 示例知识包 / 图谱关系' },
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  },
];

export const sampleKnowledgeRelations: LocalKnowledgeRelation[] = [
  {
    id: 'sample-relation-001',
    sourceId: 'sample-knowledge-002',
    targetId: 'sample-knowledge-001',
    type: 'supports',
    strength: 0.83,
    signal: '导入切片策略支撑首批种子知识入库',
  },
  {
    id: 'sample-relation-002',
    sourceId: 'sample-knowledge-004',
    targetId: 'sample-knowledge-001',
    type: 'supports',
    strength: 0.91,
    signal: '完成一次入库动作即可走通首次知识旅程',
  },
  {
    id: 'sample-relation-003',
    sourceId: 'sample-knowledge-005',
    targetId: 'sample-knowledge-001',
    type: 'depends_on',
    strength: 0.76,
    signal: '先有种子知识，首轮搜索才有命中体验',
  },
  {
    id: 'sample-relation-004',
    sourceId: 'sample-knowledge-006',
    targetId: 'sample-knowledge-005',
    type: 'co_occurs',
    strength: 0.64,
    signal: '搜索命中后通常会继续去图谱看关系网络',
  },
];
