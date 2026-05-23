/**
 * ActivityStreamService — FR-W04 活动流数据层
 *
 * AC1: 核心事件记录（创建、更新、废弃、冲突检测/解决、调研完成、规则变更）
 * AC2: 按事件类型筛选 + 按日期分组 + 统一时间格式
 * AC3: 实时推送（通过 EventBus 订阅 pipeline 事件）
 * AC4: 断线重连补发（内存环形缓存 + Last-Event-ID）
 */

import type { PipelineEvent, PipelineEventType } from '../types/index.js';
import type { EventBus } from '../pipeline/event-bus.js';
import type {
  ActivityEvent,
  ActivityEventType,
  ActivityStreamQuery,
  ActivityStreamResult,
  DateGroup,
} from './workbench-types.js';

export interface ActivityStreamServiceOptions {
  /** Recent events retained in memory for Last-Event-ID replay. Defaults to 1000. */
  cacheLimit?: number;
}

export type ActivityListener = (event: ActivityEvent) => void;

export class ActivityStreamService {
  private events: ActivityEvent[] = [];
  private listeners: Set<ActivityListener> = new Set();
  private sequence = 0;
  private readonly cacheLimit: number;

  constructor(private eventBus?: EventBus, options: ActivityStreamServiceOptions = {}) {
    this.cacheLimit = Math.max(1, options.cacheLimit ?? 1000);
    if (this.eventBus) {
      this.subscribeToPipeline();
    }
  }

  /** AC3: 注册实时监听器 */
  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 手动推入活动事件 */
  push(event: Omit<ActivityEvent, 'id' | 'eventId'>): ActivityEvent {
    const eventId = String(++this.sequence);
    const full: ActivityEvent = { ...event, id: `act-${eventId}`, eventId };
    this.events.push(full);
    if (this.events.length > this.cacheLimit) {
      this.events = this.events.slice(-this.cacheLimit);
    }
    for (const listener of this.listeners) {
      listener(full);
    }
    return full;
  }

  /** AC2 + AC4: 查询活动流（支持 Last-Event-ID 补发 + 类型筛选） */
  query(q: ActivityStreamQuery): ActivityStreamResult {
    let filtered = this.events;
    let historyLost = false;

    // AC4: Last-Event-ID replay. If the id fell out of the ring buffer,
    // tell the caller to run a full refresh instead of silently returning stale data.
    if (q.afterCursor) {
      const idx = filtered.findIndex((e) => e.eventId === q.afterCursor || e.id === q.afterCursor);
      if (idx >= 0) {
        filtered = filtered.slice(idx + 1);
      } else {
        historyLost = true;
        filtered = [];
      }
    }

    // AC2: 按事件类型筛选
    if (q.filter?.types && q.filter.types.length > 0) {
      const typeSet = new Set(q.filter.types);
      filtered = filtered.filter((e) => typeSet.has(e.type));
    }

    const limit = q.limit ?? 50;
    const page = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;

    return {
      events: page,
      cursor: page.length > 0 ? page[page.length - 1].eventId : undefined,
      hasMore,
      historyLost,
    };
  }

  /** AC2: 按日期分组 */
  groupByDate(events: ActivityEvent[]): DateGroup[] {
    const map = new Map<string, ActivityEvent[]>();
    for (const event of events) {
      const dateKey = event.timestamp.toISOString().slice(0, 10);
      const group = map.get(dateKey) ?? [];
      group.push(event);
      map.set(dateKey, group);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, evts]) => ({ date, events: evts }));
  }

  /** AC3: 订阅 pipeline EventBus，自动转换为活动事件 */
  private subscribeToPipeline(): void {
    const mapping: Partial<Record<PipelineEventType, ActivityEventType>> = {
      'entry:extracted': 'entry:created',
      'conflict:detected': 'conflict:detected',
      'conflict:resolved': 'conflict:resolved',
      'task:completed': 'research:completed',
    };

    this.eventBus!.onAny((pipelineEvent: PipelineEvent) => {
      const activityType = mapping[pipelineEvent.type];
      if (!activityType) return;
      this.push({
        type: activityType,
        timestamp: pipelineEvent.timestamp,
        summary: `${pipelineEvent.type} on task ${pipelineEvent.taskId}`,
        targetId: pipelineEvent.taskId,
        payload: pipelineEvent.payload,
      });
    });
  }
}
