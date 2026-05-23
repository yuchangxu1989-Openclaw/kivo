import { randomUUID } from 'node:crypto';
import type { ResearchTask } from './research-task-types.js';
import type {
  PriorityScore,
  ResearchQueueState,
  ResearchScheduleDecision,
  SchedulerConfig,
} from './research-scheduler-types.js';
import { ensureOperationalTables, openOperationalDb, type OperationalDbOptions } from '../utils/operational-db.js';

const PRIORITY_BASE_SCORE = {
  high: 30,
  medium: 20,
  low: 10,
} as const;

export interface ResearchSchedulerOptions extends OperationalDbOptions {
  now?: () => Date;
  maxConcurrent?: number;
  dailyBudget?: number;
}

export class PriorityQueue<T extends { id: string; priority: 'high' | 'medium' | 'low' }> {
  private readonly buckets = {
    high: [] as T[],
    medium: [] as T[],
    low: [] as T[],
  };

  enqueue(item: T): void {
    this.buckets[item.priority].push(item);
  }

  dequeue(): T | undefined {
    return this.buckets.high.shift() ?? this.buckets.medium.shift() ?? this.buckets.low.shift();
  }

  drain(): T[] {
    return [...this.buckets.high, ...this.buckets.medium, ...this.buckets.low];
  }

  size(): number {
    return this.buckets.high.length + this.buckets.medium.length + this.buckets.low.length;
  }
}

export class ResearchScheduler {
  private readonly now: () => Date;
  private readonly maxConcurrent: number;
  private readonly dailyBudget: number;
  private readonly dbOptions: OperationalDbOptions;

  constructor(options: ResearchSchedulerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.dailyBudget = options.dailyBudget ?? 50;
    this.dbOptions = {
      cwd: options.cwd,
      dbPath: options.dbPath,
    };
  }

  schedule(tasks: ResearchTask[], config: SchedulerConfig): ResearchScheduleDecision {
    const now = new Date(this.now());
    const scores = tasks.map((task) => this.score(task)).sort((a, b) => b.score - a.score);
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const sortedTasks = scores
      .map((score) => taskMap.get(score.taskId))
      .filter((task): task is ResearchTask => Boolean(task));

    const runnableCandidates = sortedTasks.filter((task) => !isDeferredByFrequency(task, config, now));
    const deferred = sortedTasks.filter((task) => isDeferredByFrequency(task, config, now));

    if (config.silentMode) {
      return {
        runnable: [],
        deferred,
        skipped: sortedTasks,
        queued: [],
        scores,
        nextRunAt: new Date(now.getTime() + config.frequencyMs),
        silentMode: true,
        userTaskActive: Boolean(config.userTaskActive),
        budgetRemaining: this.getBudgetRemaining(now, config.dailyBudget),
        status: 'silent',
      };
    }

    if (config.userTaskActive) {
      return {
        runnable: [],
        deferred,
        skipped: runnableCandidates,
        queued: runnableCandidates,
        scores,
        nextRunAt: new Date(now.getTime() + config.frequencyMs),
        silentMode: false,
        userTaskActive: true,
        budgetRemaining: this.getBudgetRemaining(now, config.dailyBudget),
        status: 'user_task_active',
      };
    }

    const queue = new PriorityQueue<ResearchTask>();
    for (const task of runnableCandidates) {
      queue.enqueue(task);
    }

    const concurrencyLimit = Math.max(0, config.maxConcurrentResearchTasks || this.maxConcurrent);
    const runningCount = this.getRunningCount();
    const availableSlots = Math.max(0, concurrencyLimit - runningCount);
    const budgetRemaining = this.getBudgetRemaining(now, config.dailyBudget);

    if (budgetRemaining <= 0) {
      return {
        runnable: [],
        deferred,
        skipped: [],
        queued: queue.drain(),
        scores,
        nextRunAt: nextUtcMidnight(now),
        silentMode: false,
        userTaskActive: false,
        budgetRemaining: 0,
        status: 'budget_exhausted',
      };
    }

    const runnable: ResearchTask[] = [];
    const queueBudget = Math.min(availableSlots, budgetRemaining);
    for (let index = 0; index < queueBudget; index += 1) {
      const task = queue.dequeue();
      if (!task) {
        break;
      }
      runnable.push(task);
    }

    this.recordScheduledRuns(runnable, now);

    const queued = queue.drain();
    return {
      runnable,
      deferred,
      skipped: queued,
      queued,
      scores,
      nextRunAt: new Date(now.getTime() + config.frequencyMs),
      silentMode: false,
      userTaskActive: false,
      budgetRemaining: Math.max(0, budgetRemaining - runnable.length),
      status: 'scheduled',
    };
  }

  getQueueState(tasks: ResearchTask[], config: SchedulerConfig): ResearchQueueState {
    const decision = this.schedulePreview(tasks, config);
    return {
      running: this.getRunningCount(),
      queued: decision.queued.length,
      budgetRemaining: decision.budgetRemaining,
    };
  }

  score(task: ResearchTask): PriorityScore {
    const score = PRIORITY_BASE_SCORE[task.priority] + task.impactScore * task.urgencyScore + (task.blocking ? 5 : 0);
    return {
      taskId: task.id,
      score,
      impactScore: task.impactScore,
      urgencyScore: task.urgencyScore,
      priority: task.priority,
      blocking: task.blocking,
    };
  }

  markCompleted(taskId: string, status: 'completed' | 'failed' | 'cancelled' = 'completed'): void {
    const db = openOperationalDb(this.dbOptions);
    try {
      ensureOperationalTables(db);
      db.prepare(`
        UPDATE research_scheduler_runs
        SET status = ?
        WHERE task_id = ? AND status = 'running'
      `).run(status, taskId);
    } finally {
      db.close();
    }
  }

  private schedulePreview(tasks: ResearchTask[], config: SchedulerConfig): ResearchScheduleDecision {
    const now = new Date(this.now());
    const scores = tasks.map((task) => this.score(task)).sort((a, b) => b.score - a.score);
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const sortedTasks = scores
      .map((score) => taskMap.get(score.taskId))
      .filter((task): task is ResearchTask => Boolean(task));
    const deferred = sortedTasks.filter((task) => isDeferredByFrequency(task, config, now));
    const runnableCandidates = sortedTasks.filter((task) => !isDeferredByFrequency(task, config, now));
    const queue = new PriorityQueue<ResearchTask>();
    runnableCandidates.forEach((task) => queue.enqueue(task));
    const budgetRemaining = this.getBudgetRemaining(now, config.dailyBudget);
    const queued = queue.drain();
    return {
      runnable: [],
      deferred,
      skipped: queued,
      queued,
      scores,
      nextRunAt: new Date(now.getTime() + config.frequencyMs),
      silentMode: Boolean(config.silentMode),
      userTaskActive: Boolean(config.userTaskActive),
      budgetRemaining,
      status: budgetRemaining <= 0 ? 'budget_exhausted' : 'scheduled',
    };
  }

  private getRunningCount(): number {
    const db = openOperationalDb(this.dbOptions);
    try {
      ensureOperationalTables(db);
      const row = db.prepare(
        `SELECT COUNT(*) AS count FROM research_scheduler_runs WHERE status = 'running'`
      ).get() as { count: number };
      return row.count;
    } finally {
      db.close();
    }
  }

  private getBudgetRemaining(now: Date, overrideDailyBudget?: number): number {
    const dailyBudget = overrideDailyBudget ?? this.dailyBudget;
    const db = openOperationalDb(this.dbOptions);
    try {
      ensureOperationalTables(db);
      const range = utcDayRange(now);
      const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM research_scheduler_runs
        WHERE created_at >= ? AND created_at < ?
      `).get(range.start, range.end) as { count: number };
      return Math.max(0, dailyBudget - row.count);
    } finally {
      db.close();
    }
  }

  private recordScheduledRuns(tasks: ResearchTask[], now: Date): void {
    if (tasks.length === 0) {
      return;
    }

    const db = openOperationalDb(this.dbOptions);
    try {
      ensureOperationalTables(db);
      const insert = db.prepare(`
        INSERT INTO research_scheduler_runs (id, task_id, priority, status, created_at)
        VALUES (?, ?, ?, 'running', ?)
      `);
      const createdAt = now.toISOString();
      const transaction = db.transaction((queuedTasks: ResearchTask[]) => {
        for (const task of queuedTasks) {
          insert.run(randomUUID(), task.id, task.priority, createdAt);
        }
      });
      transaction(tasks);
    } finally {
      db.close();
    }
  }
}

function isDeferredByFrequency(task: ResearchTask, _config: SchedulerConfig, now: Date): boolean {
  if (!task.scheduleAfter) {
    return false;
  }
  return task.scheduleAfter.getTime() > now.getTime();
}

function utcDayRange(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function nextUtcMidnight(now: Date): Date {
  const { end } = utcDayRange(now);
  return new Date(end);
}
