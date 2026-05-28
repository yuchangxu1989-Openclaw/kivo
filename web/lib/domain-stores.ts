/**
 * Domain Stores - In-memory stores for Web-layer features.
 * Seeded with generic demo data on first access when empty.
 * Routes import from here instead of demo-dashboard-data.
 */

import Database from 'better-sqlite3';
import path from 'path';

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
  DispatchAlert,
  GapHistoryReport,
  GapReportData,
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
  activityNextEventId: number;
  research: ResearchDashboardData;
  researchSeeded: boolean;
  conflicts: ConflictRecordView[];
  conflictsSeeded: boolean;
}

type GlobalWithStores = typeof globalThis & { [STORE_KEY]?: DomainStores };

function getStores(): DomainStores {
  const scope = globalThis as GlobalWithStores;
  if (!scope[STORE_KEY]) {
    scope[STORE_KEY] = {
      activity: [], activitySeeded: false, activityNextEventId: 1,
      research: { autoResearchPaused: false, tasks: [] }, researchSeeded: false,
      conflicts: [], conflictsSeeded: false,
    };
  }
  return scope[STORE_KEY]!;
}

// ─── Activity Store ─────────────────────────────────────────────────────────

const ACTIVITY_CACHE_LIMIT = Number.parseInt(process.env.KIVO_ACTIVITY_CACHE_LIMIT ?? '1000', 10);
const ACTIVITY_RING_LIMIT = Number.isFinite(ACTIVITY_CACHE_LIMIT) && ACTIVITY_CACHE_LIMIT > 0 ? ACTIVITY_CACHE_LIMIT : 1000;

const activityFilters: ActivityFilter[] = [
  { key: 'all', label: '全部事件' },
  { key: 'knowledge', label: '知识入库 / 过期' },
  { key: 'conflict', label: '冲突' },
  { key: 'research', label: '调研' },
  { key: 'rule', label: '规则变更' },
  { key: 'governance', label: '治理操作' },
];

function makeActivityEvent(
  input: Omit<ActivityEvent, 'id' | 'eventId' | 'time' | 'occurredAt'> & { occurredAt?: Date },
  currentIds: string[] = [],
) {
  const s = getStores();
  const occurredAt = input.occurredAt ?? new Date();
  const eventId = String(s.activityNextEventId++);
  return {
    id: nextId('evt', currentIds),
    eventId,
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
  // No mock data — activity is derived from real DB entries
}

export function appendActivityEvent(input: Omit<ActivityEvent, 'id' | 'eventId' | 'time' | 'occurredAt'> & { occurredAt?: Date }) {
  seedActivity();
  const s = getStores();
  const event = makeActivityEvent(input, s.activity.map((i) => i.id));
  s.activity = [event, ...s.activity].slice(0, ACTIVITY_RING_LIMIT);
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
  const index = feed.findIndex((item) => item.eventId === lastEventId || item.id === lastEventId);
  if (index === -1) return clone(feed.slice(0, 20).reverse());
  return clone(feed.slice(0, index).reverse());
}

export function getActivityReplay(lastEventId?: string): { events: ActivityEvent[]; historyLost: boolean } {
  const feed = getActivityFeedData().items;
  if (!lastEventId) return { events: [], historyLost: false };

  const index = feed.findIndex((item) => item.eventId === lastEventId || item.id === lastEventId);
  if (index === -1) {
    return { events: [], historyLost: true };
  }

  return { events: clone(feed.slice(0, index).reverse()), historyLost: false };
}

// ─── Research Store ─────────────────────────────────────────────────────────

function seedResearch() {
  const s = getStores();
  if (s.researchSeeded) return;
  s.researchSeeded = true;
  if (s.research.tasks.length > 0) return;
  // No mock data - start with empty queue
  s.research = {
    autoResearchPaused: false,
    tasks: [],
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
  appendActivityEvent({ type: 'research_created', label: '新调研任务', summary: `已创建调研任务「${task.topic}」,预算 ${task.budgetCredits} 点,等待进入队列。`, href: '/research', tags: ['research', 'queued'] });
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

export function adoptResearchTask(id: string): ResearchDashboardData | null {
  seedResearch();
  const s = getStores();
  let found = false; let topic = '';
  s.research = { ...s.research, tasks: s.research.tasks.map((t) => {
    if (t.id !== id || t.status !== 'completed') return t;
    found = true; topic = t.topic;
    return { ...t, adopted: true };
  }) };
  if (found) appendActivityEvent({ type: 'research_adopted', label: '调研报告采纳', summary: `调研报告「${topic}」已采纳入知识库。`, href: '/research', tags: ['research', 'adopted'] });
  return found ? getResearchDashboardData() : null;
}

export function updateResearchHighlight(id: string, highlighted: boolean): ResearchDashboardData | null {
  seedResearch();
  const s = getStores();
  let found = false; let topic = '';
  s.research = { ...s.research, tasks: s.research.tasks.map((t) => {
    if (t.id !== id) return t;
    found = true; topic = t.topic;
    return { ...t, highlighted };
  }) };
  if (found) appendActivityEvent({ type: 'research_highlighted', label: highlighted ? '调研标记重点' : '调研取消重点', summary: `调研任务「${topic}」${highlighted ? '已标记为重点' : '已取消重点标记'}。`, href: '/research', tags: ['research', 'highlight'] });
  return found ? getResearchDashboardData() : null;
}

// ─── Dictionary Store ───────────────────────────────────────────────────────

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');
const DICTIONARY_DOMAIN = 'system-dictionary';

interface DictionaryEntryRow {
  id: string;
  title: string;
  content: string;
  metadata_json: string | null;
  updated_at: string;
}

function openDictionaryDb(readonly = false) {
  return new Database(DB_PATH, {
    readonly,
    fileMustExist: readonly,
  });
}

function parseDictionaryMetadata(value: string | null): Pick<DictionaryEntry, 'aliases' | 'scope'> {
  if (!value) return { aliases: [], scope: '全局' };

  try {
    const parsed = JSON.parse(value) as { aliases?: unknown; scope?: unknown };
    return {
      aliases: Array.isArray(parsed.aliases) ? parsed.aliases.filter((item): item is string => typeof item === 'string') : [],
      scope: typeof parsed.scope === 'string' && parsed.scope.trim() ? parsed.scope : '全局',
    };
  } catch {
    return { aliases: [], scope: '全局' };
  }
}

function makeDictionaryMetadata(input: Pick<DictionaryEntry, 'aliases' | 'scope'>) {
  return JSON.stringify({ aliases: input.aliases ?? [], scope: input.scope ?? '全局' });
}

function mapDictionaryRow(row: DictionaryEntryRow): DictionaryEntry {
  const metadata = parseDictionaryMetadata(row.metadata_json);
  return {
    id: row.id,
    term: row.title,
    definition: row.content,
    aliases: metadata.aliases,
    scope: metadata.scope,
    updatedAt: formatRelative(new Date(row.updated_at)),
  };
}

export function getDictionaryData(): DictionaryData {
  const db = openDictionaryDb(true);
  try {
    const rows = db.prepare(`
      SELECT id, title, content, metadata_json, updated_at
      FROM entries
      WHERE domain = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC, created_at DESC, id ASC
    `).all(DICTIONARY_DOMAIN) as DictionaryEntryRow[];

    return clone({ entries: rows.map(mapDictionaryRow) });
  } finally {
    db.close();
  }
}

export function createDictionaryEntry(input: Omit<DictionaryEntry, 'id' | 'updatedAt'>): DictionaryData {
  const db = openDictionaryDb(false);
  try {
    const existingIds = db.prepare('SELECT id FROM entries WHERE id LIKE ?').all('term-web-%') as Array<{ id: string }>;
    const id = nextId('term-web', existingIds.map((row) => row.id));
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO entries (
        id, type, title, content, summary, source_json, confidence, status, tags_json,
        domain, created_at, updated_at, version, metadata_json, origin_role
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      'fact',
      input.term,
      input.definition,
      input.definition.slice(0, 120),
      JSON.stringify({ source: 'kivo-web-dictionary' }),
      0.9,
      'active',
      JSON.stringify(['dictionary']),
      DICTIONARY_DOMAIN,
      now,
      now,
      1,
      makeDictionaryMetadata(input),
      'web',
    );

    appendActivityEvent({ type: 'dictionary_created', label: '术语新增', summary: `系统字典新增术语「${input.term}」,后续协作者会按这一定义工作。`, href: '/settings/dictionary', tags: ['governance', 'dictionary'] });
    return getDictionaryData();
  } finally {
    db.close();
  }
}

export function updateDictionaryEntry(id: string, input: Omit<DictionaryEntry, 'id' | 'updatedAt'>): DictionaryData | null {
  const db = openDictionaryDb(false);
  try {
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE entries
      SET title = ?, content = ?, summary = ?, metadata_json = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND domain = ? AND deleted_at IS NULL
    `).run(
      input.term,
      input.definition,
      input.definition.slice(0, 120),
      makeDictionaryMetadata(input),
      now,
      id,
      DICTIONARY_DOMAIN,
    );

    if (result.changes === 0) return null;

    appendActivityEvent({ type: 'dictionary_updated', label: '术语更新', summary: `术语「${input.term}」已更新,后续会话会读取最新定义。`, href: '/settings/dictionary', tags: ['governance', 'dictionary'] });
    return getDictionaryData();
  } finally {
    db.close();
  }
}

export function deleteDictionaryEntry(id: string): DictionaryData | null {
  const db = openDictionaryDb(false);
  try {
    const target = db.prepare(`
      SELECT title
      FROM entries
      WHERE id = ? AND domain = ? AND deleted_at IS NULL
    `).get(id, DICTIONARY_DOMAIN) as { title: string } | undefined;

    if (!target) return null;

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE entries
      SET deleted_at = ?, status = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND domain = ? AND deleted_at IS NULL
    `).run(now, 'deleted', now, id, DICTIONARY_DOMAIN);

    appendActivityEvent({ type: 'dictionary_deleted', label: '术语删除', summary: `术语「${target.title}」已从系统字典移除。`, href: '/settings/dictionary', tags: ['governance', 'dictionary'] });
    return getDictionaryData();
  } finally {
    db.close();
  }
}

// ─── Conflict Store ─────────────────────────────────────────────────────────

function seedConflicts() {
  const s = getStores();
  if (s.conflictsSeeded) return;
  s.conflictsSeeded = true;
  if (s.conflicts.length > 0) return;
  s.conflicts = [
    { id: 'conflict-001', summaryA: '耗时超过 30 秒的任务必须异步处理。', summaryB: '主线程可以直接处理 2-3 分钟的长任务,只要不重启。', conflictType: '执行规则冲突', detectedAt: '今天 08:52', status: 'unresolved', version: 1, entryA: { id: 'ke-004', type: 'experience', content: '长时间阻塞导致请求超时,超过 30 秒的工作必须异步处理。', confidence: 0.98, sourceType: '对话提取', createdAt: '4月28日 14:20', updatedAt: '4月30日 09:15' }, entryB: { id: 'ke-011', type: 'intent', content: '有人曾误以为主线程能稳定承接 2-3 分钟长任务,这与已知事实冲突。', confidence: 0.51, sourceType: '手动录入', createdAt: '4月29日 16:40', updatedAt: '4月29日 16:40' }, relatedEntryCount: 5, affectedEntryIds: ['ke-001', 'ke-003', 'ke-007', 'ke-012', 'ke-015'] },
    { id: 'conflict-002', summaryA: '术语表变更后,后续会话立即使用新定义。', summaryB: '术语表变更需要等旧会话自然结束后才会生效。', conflictType: '时效规则冲突', detectedAt: '今天 09:07', status: 'unresolved', version: 1, entryA: { id: 'dict-002', type: 'decision', content: '术语变更应对后续会话生效,必要时通过分发链补发。', confidence: 0.86, sourceType: '文档导入', createdAt: '4月25日 10:00', updatedAt: '4月28日 11:30' }, entryB: { id: 'dict-003', type: 'experience', content: '部分旧会话可能持有旧缓存,需要重新注入才能完全一致。', confidence: 0.72, sourceType: '对话提取', createdAt: '4月27日 09:20', updatedAt: '4月27日 09:20' }, relatedEntryCount: 3, affectedEntryIds: ['ke-002', 'ke-008', 'ke-014'] },
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
  appendActivityEvent({ type: 'conflict_resolved', label: '冲突已裁决', summary: `冲突「${updated.summaryA.slice(0, 14)}...」已完成裁决,处理策略为 ${input.strategy}。`, href: '/governance', tags: ['conflict', 'resolved'] });
  return clone(updated);
}

// ─── Intent Store ───────────────────────────────────────────────────────────

export {
  deleteIntent,
  getIntentById,
  getIntentData,
  normalizeIntentLines,
  searchIntents,
  upsertIntent,
} from './intent-store';

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
  return clone({ activeRules, failedRules, unhandledAlertCount: 0, alerts: [] as DispatchAlert[] });
}

// ─── Gaps (derived from Core entries) ───────────────────────────────────────

export function buildGapReportFromEntries(entries: Array<{ domain?: string; status: string }>): GapReportData {
  const domainCounts = new Map<string, number>();
  for (const e of entries) domainCounts.set(e.domain || '未分类', (domainCounts.get(e.domain || '未分类') || 0) + 1);
  const sorted = [...domainCounts.entries()].sort((a, b) => a[1] - b[1]);
  const weakSpots = sorted.slice(0, 3).map(([topic, count]) => ({
    topic: `${topic}知识补齐`, misses: Math.max(1, 20 - count),
    suggestion: `当前仅 ${count} 条,建议补齐该领域的 methodology 和 experience。`,
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
  DispatchAnalyticsData, DispatchRule, FailedDispatchRule, DispatchAlert,
  GapReportData, GapHistoryReport, GapSpot, LatestGapReport,
  IntentData, IntentItem, IntentSnippet,
  MissedQuery, Priority,
  ResearchDashboardData, ResearchTask, ResearchStatus,
  UtilizationAnalyticsData, UtilizationTopItem,
} from './demo-dashboard-data';
