/**
 * Domain Stores — In-memory stores for Web-layer features.
 * Seeded with generic demo data on first access when empty.
 * Routes import from here instead of demo-dashboard-data.
 */

import type {
  ActivityEvent,
  ActivityFeedData,
  ActivityFilter,
  ConflictRecordView,
  ConflictResolutionRecord,
  CoverageAnalyticsData,
  CoverageDomain,
  DictionaryData,
  DictionaryEntry,
  DispatchAnalyticsData,
  DispatchRule,
  FailedDispatchRule,
  GapHistoryReport,
  GapReportData,
  IntentData,
  IntentItem,
  LatestGapReport,
  MissedQuery,
  Priority,
  ResearchDashboardData,
  ResearchTask,
  UtilizationAnalyticsData,
  UtilizationTopItem,
} from './demo-dashboard-data';

// ─── Utility Functions ──────────────────────────────────────────────────────

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nextId(prefix: string, current: string[]) {
  const max = current
    .map((id) => Number.parseInt(id.replace(`${prefix}-`, ''), 10))
    .filter((id) => Number.isFinite(id))
    .reduce((acc, id) => Math.max(acc, id), 0);
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

function formatDateTime(date: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function formatRelative(date: Date) {
  const diff = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))} 分钟前`;
  if (diff < 24 * hour) return `${Math.max(1, Math.round(diff / hour))} 小时前`;
  return formatDateTime(date);
}

// ─── globalThis Store Pattern ───────────────────────────────────────────────

const STORE_KEY = '__kivo_domain_stores__';

interface DomainStores {
  activity: ActivityEvent[];
  activitySeeded: boolean;
  research: ResearchDashboardData;
  researchSeeded: boolean;
  dictionary: DictionaryEntry[];
  dictionarySeeded: boolean;
  conflicts: ConflictRecordView[];
  conflictsSeeded: boolean;
  intents: IntentItem[];
  intentsSeeded: boolean;
}

type GlobalWithStores = typeof globalThis & { [STORE_KEY]?: DomainStores };

function getStores(): DomainStores {
  const scope = globalThis as GlobalWithStores;
  if (!scope[STORE_KEY]) {
    scope[STORE_KEY] = {
      activity: [], activitySeeded: false,
      research: { autoResearchPaused: false, tasks: [] }, researchSeeded: false,
      dictionary: [], dictionarySeeded: false,
      conflicts: [], conflictsSeeded: false,
      intents: [], intentsSeeded: false,
    };
  }
  return scope[STORE_KEY]!;
}

// ─── Activity Store ─────────────────────────────────────────────────────────

const activityFilters: ActivityFilter[] = [
  { key: 'all', label: '全部事件' },
  { key: 'knowledge', label: '知识入库 / 过期' },
  { key: 'conflict', label: '冲突' },
  { key: 'research', label: '调研' },
  { key: 'rule', label: '规则变更' },
  { key: 'governance', label: '治理操作' },
];

function makeActivityEvent(
  input: Omit<ActivityEvent, 'id' | 'time' | 'occurredAt'> & { occurredAt?: Date },
  currentIds: string[] = [],
) {
  const occurredAt = input.occurredAt ?? new Date();
  return {
    id: nextId('evt', currentIds),
    type: input.type, label: input.label, summary: input.summary,
    href: input.href, tags: input.tags,
    time: formatRelative(occurredAt),
    occurredAt: occurredAt.toISOString(),
  } satisfies ActivityEvent;
}

function seedActivity() {
  const s = getStores();
  if (s.activitySeeded) return;
  s.activitySeeded = true;
  if (s.activity.length > 0) return;
  const events = [
    { type: 'knowledge_created', label: '新知识入库', summary: '《REST API 版本管理规范》已写入 fact 域，新增 1 条 active 条目。', href: '/knowledge/ke-005', tags: ['fact', 'active', 'knowledge'], occurredAt: new Date(Date.now() - 10 * 60 * 1000) },
    { type: 'conflict_detected', label: '冲突检测', summary: '检测到 2 组"接口版本策略"描述冲突，等待人工裁决。', href: '/conflicts', tags: ['冲突', '待处理', 'conflict'], occurredAt: new Date(Date.now() - 28 * 60 * 1000) },
    { type: 'research_completed', label: '调研完成', summary: '"API 文档覆盖薄弱领域"调研任务完成，入库 4 条 methodology / experience。', href: '/research', tags: ['调研', 'completed', 'research'], occurredAt: new Date(Date.now() - 60 * 60 * 1000) },
    { type: 'knowledge_expired', label: '知识过期', summary: '"服务重启后端口释放"经验已被删除，内容过时不再适用。', href: '/knowledge', tags: ['经验', 'knowledge'], occurredAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    { type: 'rule_changed', label: '规则变更', summary: '新增文档完整性规则，已同步到所有协作者上下文。', href: '/analytics/dispatch', tags: ['规则', '分发', 'rule'], occurredAt: new Date(Date.now() - 5 * 60 * 60 * 1000) },
  ];
  const ids: string[] = [];
  for (const e of events) {
    const evt = makeActivityEvent(e, ids);
    ids.push(evt.id);
    s.activity.push(evt);
  }
}

export function appendActivityEvent(input: Omit<ActivityEvent, 'id' | 'time' | 'occurredAt'> & { occurredAt?: Date }) {
  seedActivity();
  const s = getStores();
  const event = makeActivityEvent(input, s.activity.map((i) => i.id));
  s.activity = [event, ...s.activity].slice(0, 200);
  return clone(event);
}

export function getActivityFeedData(): ActivityFeedData {
  seedActivity();
  const s = getStores();
  s.activity = s.activity.map((item) => ({
    ...item, time: formatRelative(new Date(item.occurredAt)),
  }));
  return clone({ filters: activityFilters, items: s.activity });
}

export function getActivityEventsSince(lastEventId?: string): ActivityEvent[] {
  const feed = getActivityFeedData().items;
  if (!lastEventId) return clone(feed.slice(0, 20).reverse());
  const index = feed.findIndex((item) => item.id === lastEventId);
  if (index === -1) return clone(feed.slice(0, 20).reverse());
  return clone(feed.slice(0, index).reverse());
}

// ─── Research Store ─────────────────────────────────────────────────────────

function seedResearch() {
  const s = getStores();
  if (s.researchSeeded) return;
  s.researchSeeded = true;
  if (s.research.tasks.length > 0) return;
  s.research = {
    autoResearchPaused: false,
    tasks: [
      { id: 'rs-001', topic: 'API 文档覆盖率提升', scope: '聚焦最近 7 天高频未命中查询，补齐 methodology / experience。', status: 'running', priority: '高', createdAt: '今天 09:10', budgetCredits: 36, expectedTypes: ['methodology', 'experience'] },
      { id: 'rs-002', topic: '部署流程失败原因收敛', scope: '梳理部署失败规则与团队订阅缺口。', status: 'queued', priority: '中', createdAt: '今天 08:40', budgetCredits: 20, expectedTypes: ['decision', 'experience'] },
      { id: 'rs-003', topic: '术语表对搜索理解影响评估', scope: '检查术语变更对搜索准确率的影响。', status: 'completed', priority: '中', createdAt: '昨天 19:25', budgetCredits: 12, expectedTypes: ['fact', 'intent'], resultSummary: '完成 12 条术语匹配校验，新增 3 个建议补录术语。', knowledgeCount: 5, resultEntryIds: ['ke-020', 'ke-021', 'ke-022', 'ke-023', 'ke-024'], filledGapTopic: '术语覆盖率不足' },
      { id: 'rs-004', topic: '旧知识过期批量复核', scope: '比对 30 天未更新且命中率高的经验条目。', status: 'failed', priority: '低', createdAt: '昨天 15:20', budgetCredits: 8, expectedTypes: ['experience'], failureReason: '外部检索结果不足，需缩小主题范围后重跑。' },
    ],
  };
}

export function getResearchDashboardData(): ResearchDashboardData {
  seedResearch();
  return clone(getStores().research);
}

export function createResearchTask(input: { topic: string; scope: string; priority: Priority; budgetCredits: number; expectedTypes: string[] }): ResearchDashboardData {
  seedResearch();
  const s = getStores();
  const task: ResearchTask = {
    id: nextId('rs', s.research.tasks.map((i) => i.id)),
    ...input, status: 'queued', createdAt: '刚刚',
  };
  s.research = { ...s.research, tasks: [task, ...s.research.tasks] };
  appendActivityEvent({ type: 'research_created', label: '新调研任务', summary: `已创建调研任务「${task.topic}」，预算 ${task.budgetCredits} 点，等待进入队列。`, href: '/research', tags: ['research', 'queued'] });
  return getResearchDashboardData();
}

export function updateResearchTaskPriority(id: string, priority: Priority): ResearchDashboardData | null {
  seedResearch();
  const s = getStores();
  let found = false; let topic = '';
  s.research = { ...s.research, tasks: s.research.tasks.map((t) => {
    if (t.id !== id) return t;
    found = true; topic = t.topic;
    return { ...t, priority };
  }) };
  if (found) appendActivityEvent({ type: 'research_updated', label: '调研优先级调整', summary: `调研任务「${topic}」的优先级已调整为「${priority}」。`, href: '/research', tags: ['research', 'priority'] });
  return found ? getResearchDashboardData() : null;
}

export function deleteResearchTask(id: string): ResearchDashboardData | null {
  seedResearch();
  const s = getStores();
  const target = s.research.tasks.find((t) => t.id === id);
  const before = s.research.tasks.length;
  s.research = { ...s.research, tasks: s.research.tasks.filter((t) => t.id !== id) };
  if (target && before !== s.research.tasks.length) appendActivityEvent({ type: 'research_cancelled', label: '调研取消', summary: `调研任务「${target.topic}」已从队列中移除。`, href: '/research', tags: ['research', 'cancelled'] });
  return before === s.research.tasks.length ? null : getResearchDashboardData();
}

export function setResearchAutoPaused(paused: boolean): ResearchDashboardData {
  seedResearch();
  const s = getStores();
  s.research = { ...s.research, autoResearchPaused: paused };
  appendActivityEvent({ type: paused ? 'research_paused' : 'research_resumed', label: paused ? '自动调研暂停' : '自动调研恢复', summary: paused ? '调研队列已进入静默模式。' : '调研队列已恢复自动处理。', href: '/research', tags: ['research', paused ? 'paused' : 'resumed'] });
  return getResearchDashboardData();
}

// ─── Dictionary Store ───────────────────────────────────────────────────────

function seedDictionary() {
  const s = getStores();
  if (s.dictionarySeeded) return;
  s.dictionarySeeded = true;
  if (s.dictionary.length > 0) return;
  s.dictionary = [
    { id: 'dict-001', term: 'REST', definition: 'Representational State Transfer，一种基于 HTTP 的 API 设计风格。', aliases: ['RESTful'], scope: '全局', updatedAt: '今天 09:30' },
    { id: 'dict-002', term: '微服务', definition: '将应用拆分为独立部署的小型服务，每个服务负责单一业务能力。', aliases: ['Microservice'], scope: '架构设计', updatedAt: '昨天 18:00' },
    { id: 'dict-003', term: 'CI/CD', definition: '持续集成与持续交付，自动化构建、测试和部署流程。', aliases: ['持续集成'], scope: '部署运维', updatedAt: '昨天 16:45' },
  ];
}

export function getDictionaryData(): DictionaryData {
  seedDictionary();
  return clone({ entries: getStores().dictionary });
}

export function createDictionaryEntry(input: Omit<DictionaryEntry, 'id' | 'updatedAt'>): DictionaryData {
  seedDictionary();
  const s = getStores();
  const entry: DictionaryEntry = { ...input, id: nextId('dict', s.dictionary.map((i) => i.id)), updatedAt: '刚刚' };
  s.dictionary = [entry, ...s.dictionary];
  appendActivityEvent({ type: 'dictionary_created', label: '术语新增', summary: `系统字典新增术语「${entry.term}」，后续协作者会按这一定义工作。`, href: '/settings/dictionary', tags: ['governance', 'dictionary'] });
  return getDictionaryData();
}

export function updateDictionaryEntry(id: string, input: Omit<DictionaryEntry, 'id' | 'updatedAt'>): DictionaryData | null {
  seedDictionary();
  const s = getStores();
  let found = false;
  s.dictionary = s.dictionary.map((e) => {
    if (e.id !== id) return e;
    found = true;
    return { ...e, ...input, updatedAt: '刚刚' };
  });
  if (found) appendActivityEvent({ type: 'dictionary_updated', label: '术语更新', summary: `术语「${input.term}」已更新，后续会话会读取最新定义。`, href: '/settings/dictionary', tags: ['governance', 'dictionary'] });
  return found ? getDictionaryData() : null;
}

export function deleteDictionaryEntry(id: string): DictionaryData | null {
  seedDictionary();
  const s = getStores();
  const target = s.dictionary.find((e) => e.id === id);
  const before = s.dictionary.length;
  s.dictionary = s.dictionary.filter((e) => e.id !== id);
  if (target && before !== s.dictionary.length) appendActivityEvent({ type: 'dictionary_deleted', label: '术语删除', summary: `术语「${target.term}」已从系统字典移除。`, href: '/settings/dictionary', tags: ['governance', 'dictionary'] });
  return before === s.dictionary.length ? null : getDictionaryData();
}

// ─── Conflict Store ─────────────────────────────────────────────────────────

function seedConflicts() {
  const s = getStores();
  if (s.conflictsSeeded) return;
  s.conflictsSeeded = true;
  if (s.conflicts.length > 0) return;
  s.conflicts = [
    { id: 'conflict-001', summaryA: '耗时超过 30 秒的任务必须异步处理。', summaryB: '主线程可以直接处理 2-3 分钟的长任务，只要不重启。', conflictType: '执行规则冲突', detectedAt: '今天 08:52', status: 'unresolved', version: 1, entryA: { id: 'ke-004', type: 'experience', content: '长时间阻塞导致请求超时，超过 30 秒的工作必须异步处理。', confidence: 0.98, sourceType: '对话提取', createdAt: '4月28日 14:20', updatedAt: '4月30日 09:15' }, entryB: { id: 'ke-011', type: 'intent', content: '有人曾误以为主线程能稳定承接 2-3 分钟长任务，这与已知事实冲突。', confidence: 0.51, sourceType: '手动录入', createdAt: '4月29日 16:40', updatedAt: '4月29日 16:40' }, relatedEntryCount: 5, affectedEntryIds: ['ke-001', 'ke-003', 'ke-007', 'ke-012', 'ke-015'] },
    { id: 'conflict-002', summaryA: '术语表变更后，后续会话立即使用新定义。', summaryB: '术语表变更需要等旧会话自然结束后才会生效。', conflictType: '时效规则冲突', detectedAt: '今天 09:07', status: 'unresolved', version: 1, entryA: { id: 'dict-002', type: 'decision', content: '术语变更应对后续会话生效，必要时通过分发链补发。', confidence: 0.86, sourceType: '文档导入', createdAt: '4月25日 10:00', updatedAt: '4月28日 11:30' }, entryB: { id: 'dict-003', type: 'experience', content: '部分旧会话可能持有旧缓存，需要重新注入才能完全一致。', confidence: 0.72, sourceType: '对话提取', createdAt: '4月27日 09:20', updatedAt: '4月27日 09:20' }, relatedEntryCount: 3, affectedEntryIds: ['ke-002', 'ke-008', 'ke-014'] },
  ];
}

export function getConflictData() {
  seedConflicts();
  return clone({ items: getStores().conflicts });
}

export function getConflictPendingCount() {
  seedConflicts();
  return getStores().conflicts.filter((i) => i.status === 'unresolved').length;
}

export function resolveConflictRecord(input: {
  id: string;
  strategy: ConflictResolutionRecord['strategy'];
  operator: string;
  reason: string;
  mergedContent?: string;
  expectedVersion: number;
}): ConflictRecordView | null {
  seedConflicts();
  const s = getStores();
  const idx = s.conflicts.findIndex((i) => i.id === input.id);
  if (idx === -1) return null;
  const item = s.conflicts[idx];
  if (item.version !== input.expectedVersion) throw new Error(`VERSION_CONFLICT:${item.version}`);
  const updated: ConflictRecordView = {
    ...item, status: 'resolved', version: item.version + 1,
    mergedContent: input.mergedContent,
    resolution: { operator: input.operator, decidedAt: formatDateTime(new Date()), reason: input.reason, strategy: input.strategy },
  };
  s.conflicts[idx] = updated;
  appendActivityEvent({ type: 'conflict_resolved', label: '冲突已裁决', summary: `冲突「${updated.summaryA.slice(0, 14)}…」已完成裁决，处理策略为 ${input.strategy}。`, href: '/conflicts', tags: ['conflict', 'resolved'] });
  return clone(updated);
}

// ─── Intent Store ───────────────────────────────────────────────────────────

function seedIntents() {
  const s = getStores();
  if (s.intentsSeeded) return;
  s.intentsSeeded = true;
  if (s.intents.length > 0) return;
  s.intents = [
    { id: 'intent-001', name: '进度追踪', description: '用户希望快速知道项目到了哪一步、剩下什么阻塞。', positives: ['项目现在做到哪了？', '这个批次还差什么？', '直接告诉我进度和风险'], negatives: ['随便聊聊项目名字', '写一首诗'], relatedEntryCount: 6, recentHitCount: 42, recentSnippets: [{ id: 'hit-001', excerpt: '这个批次还差什么？', hitAt: '今天 10:18' }, { id: 'hit-002', excerpt: '直接告诉我进度和风险。', hitAt: '昨天 18:42' }], updateStatus: 'synced', updatedAt: '今天 10:12' },
    { id: 'intent-002', name: '严谨查证', description: '用户要求先查事实再结论，不能凭记忆回答。', positives: ['先读文档再回我', '别猜，先查配置', '我要客观结果'], negatives: ['凭经验大概说说', '你觉得应该是这样吧'], relatedEntryCount: 9, recentHitCount: 58, recentSnippets: [{ id: 'hit-004', excerpt: '别猜，先查配置。', hitAt: '今天 09:56' }], updateStatus: 'synced', updatedAt: '今天 09:58' },
    { id: 'intent-003', name: '长期文档沉淀', description: '要求把关键结论写入可复查的文档，而不是只留在聊天里。', positives: ['把报告写到 reports/ 里', '别只回我结论，要落文件'], negatives: ['不用写了，你自己记住就行'], relatedEntryCount: 4, recentHitCount: 18, recentSnippets: [{ id: 'hit-007', excerpt: '把报告写到 reports/ 里。', hitAt: '今天 08:44' }], updateStatus: 'idle', updatedAt: '昨天 20:11' },
  ];
}

export function getIntentData(): IntentData {
  seedIntents();
  return clone({ items: getStores().intents });
}

export function getIntentById(id: string) {
  seedIntents();
  const item = getStores().intents.find((e) => e.id === id);
  return item ? clone(item) : null;
}

export function upsertIntent(input: { id?: string; name: string; description: string; positives: string[]; negatives: string[]; relatedEntryCount: number }) {
  seedIntents();
  const s = getStores();
  const updatedAt = formatDateTime(new Date());
  if (input.id) {
    let found = false;
    s.intents = s.intents.map((item) => {
      if (item.id !== input.id) return item;
      found = true;
      return { ...item, ...input, updateStatus: 'synced' as const, updatedAt };
    });
    if (!found) return null;
    appendActivityEvent({ type: 'intent_updated', label: '意图更新', summary: `意图「${input.name}」已保存，并触发增量更新。`, href: '/intents', tags: ['governance', 'intent'] });
    return getIntentData();
  }
  const item: IntentItem = { id: nextId('intent', s.intents.map((e) => e.id)), name: input.name, description: input.description, positives: input.positives, negatives: input.negatives, relatedEntryCount: input.relatedEntryCount, recentHitCount: 0, recentSnippets: [], updateStatus: 'synced', updatedAt };
  s.intents = [item, ...s.intents];
  appendActivityEvent({ type: 'intent_created', label: '意图新增', summary: `意图库新增意图「${item.name}」，增量更新已触发。`, href: '/intents', tags: ['governance', 'intent'] });
  return getIntentData();
}

export function deleteIntent(id: string) {
  seedIntents();
  const s = getStores();
  const target = s.intents.find((i) => i.id === id);
  const before = s.intents.length;
  s.intents = s.intents.filter((i) => i.id !== id);
  if (target && before !== s.intents.length) appendActivityEvent({ type: 'intent_deleted', label: '意图删除', summary: `意图「${target.name}」已删除，关联条目数为 ${target.relatedEntryCount}。`, href: '/intents', tags: ['governance', 'intent'] });
  return before === s.intents.length ? null : getIntentData();
}

// ─── Analytics: Coverage (derived from Core entries) ────────────────────────

export function buildCoverageFromEntries(entries: Array<{ domain?: string; status: string }>): CoverageAnalyticsData {
  const domainMap = new Map<string, { count: number; activeCount: number }>();
  for (const e of entries) {
    const d = e.domain || '未分类';
    const cur = domainMap.get(d) || { count: 0, activeCount: 0 };
    cur.count++;
    if (e.status === 'active') cur.activeCount++;
    domainMap.set(d, cur);
  }
  const domains: CoverageDomain[] = [];
  for (const [name, { count, activeCount }] of domainMap) {
    const hitRate = count > 0 ? Math.round((activeCount / count) * 100) : 0;
    domains.push({ name, count, trend: '+0', weak: hitRate < 60, hitRate });
  }
  domains.sort((a, b) => b.count - a.count);
  return { domains };
}

// ─── Analytics: Utilization (derived from Core entries) ─────────────────────

export function buildUtilizationFromEntries(entries: Array<{ title: string; type: string; status: string; confidence?: number; updatedAt: Date | string }>): UtilizationAnalyticsData {
  const sorted = [...entries].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const topUsed: UtilizationTopItem[] = sorted.slice(0, 4).map((e) => ({ name: e.title, hits: Math.round((e.confidence ?? 0.5) * 100), type: e.type }));
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 86400000;
  const sleeping = entries.filter((e) => new Date(e.updatedAt).getTime() < thirtyDaysAgo).map((e) => e.title).slice(0, 5);
  const missedQueries: MissedQuery[] = [
    { query: '部署失败后怎么自动恢复', count: 13 },
    { query: '术语表热更新后会话是否立即生效', count: 9 },
    { query: '过时知识重新激活的判断标准', count: 7 },
  ];
  return { topUsed, sleepingKnowledge: sleeping, missedQueries };
}

// ─── Analytics: Dispatch (static operational data) ──────────────────────────

export function getDispatchAnalyticsData(): DispatchAnalyticsData {
  const activeRules: DispatchRule[] = [
    { name: '文档完整性规则', subscribers: 8, lastDistributedAt: '今天 10:08', status: '已生效' },
    { name: '数据源优先规则', subscribers: 8, lastDistributedAt: '今天 10:06', status: '已生效' },
    { name: '主线程保持响应规则', subscribers: 6, lastDistributedAt: '今天 09:55', status: '已生效' },
    { name: '术语表强制注册规则', subscribers: 5, lastDistributedAt: '今天 09:48', status: '部分生效' },
  ];
  const failedRules: FailedDispatchRule[] = [
    { name: '术语表强制注册规则', reason: '2 个协作者会话仍使用旧版本缓存。' },
    { name: '外部数据源同步协议', reason: '目标协作者当前未订阅该知识域上下文。' },
  ];
  return clone({ activeRules, failedRules });
}

// ─── Gaps (derived from Core entries) ───────────────────────────────────────

export function buildGapReportFromEntries(entries: Array<{ domain?: string; status: string }>): GapReportData {
  const domainCounts = new Map<string, number>();
  for (const e of entries) domainCounts.set(e.domain || '未分类', (domainCounts.get(e.domain || '未分类') || 0) + 1);
  const sorted = [...domainCounts.entries()].sort((a, b) => a[1] - b[1]);
  const weakSpots = sorted.slice(0, 3).map(([topic, count]) => ({
    topic: `${topic}知识补齐`, misses: Math.max(1, 20 - count),
    suggestion: `当前仅 ${count} 条，建议补齐该领域的 methodology 和 experience。`,
    progress: count < 5 ? '待启动调研' : count < 10 ? '进行中' : '已形成草案',
  }));
  const latestReport: LatestGapReport = { generatedAt: formatDateTime(new Date()), weakSpots };
  const historyReports: GapHistoryReport[] = [
    { date: '昨天', title: '搜索未命中聚类报告', coverage: '已补齐 2 / 5 个盲区' },
    { date: '上周', title: '调研失败主题回收报告', coverage: '已完成重试策略梳理' },
  ];
  return { latestReport, historyReports };
}

// ─── Re-export types for convenience ────────────────────────────────────────

export type {
  ActivityEvent, ActivityFeedData, ActivityFilter,
  ConflictRecordView, ConflictResolutionRecord, ConflictEntryPreview,
  CoverageAnalyticsData, CoverageDomain,
  DictionaryData, DictionaryEntry,
  DispatchAnalyticsData, DispatchRule, FailedDispatchRule,
  GapReportData, GapHistoryReport, GapSpot, LatestGapReport,
  IntentData, IntentItem, IntentSnippet,
  MissedQuery, Priority,
  ResearchDashboardData, ResearchTask, ResearchStatus,
  UtilizationAnalyticsData, UtilizationTopItem,
} from './demo-dashboard-data';
