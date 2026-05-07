import type { ResearchTask } from './research-task-types.js';
import type { PriorityScore, ResearchScheduleDecision, SchedulerConfig } from './research-scheduler-types.js';

const PRIORITY_BASE_SCORE = {
  high: 30,
  medium: 20,
  low: 10,
} as const;

export interface ResearchSchedulerOptions {
  now?: () => Date;
}

export class ResearchScheduler {
  private readonly now: () => Date;

  constructor(options: ResearchSchedulerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  schedule(tasks: ResearchTask[], config: SchedulerConfig): ResearchScheduleDecision {
    const now = new Date(this.now());
    const scores = tasks.map((task) => this.score(task)).sort((a, b) => b.score - a.score);
    const sortedTasks = scores
      .map((score) => tasks.find((task) => task.id === score.taskId))
      .filter((task): task is ResearchTask => Boolean(task));

    const runnableCandidates = sortedTasks.filter((task) => !isDeferredByFrequency(task, config, now));
    const deferred = sortedTasks.filter((task) => isDeferredByFrequency(task, config, now));

    if (config.silentMode) {
      return {
        runnable: [],
        deferred,
        skipped: sortedTasks,
        scores,
        nextRunAt: new Date(now.getTime() + config.frequencyMs),
        silentMode: true,
        userTaskActive: Boolean(config.userTaskActive),
      };
    }

    if (config.userTaskActive) {
      return {
        runnable: [],
        deferred,
        skipped: runnableCandidates,
        scores,
        nextRunAt: new Date(now.getTime() + config.frequencyMs),
        silentMode: false,
        userTaskActive: true,
      };
    }

    const limit = Math.max(0, config.maxConcurrentResearchTasks);
    const runnable = runnableCandidates.slice(0, limit);
    const skipped = runnableCandidates.slice(limit);

    return {
      runnable,
      deferred,
      skipped,
      scores,
      nextRunAt: new Date(now.getTime() + config.frequencyMs),
      silentMode: false,
      userTaskActive: false,
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
}

function isDeferredByFrequency(task: ResearchTask, config: SchedulerConfig, now: Date): boolean {
  if (!task.scheduleAfter) {
    return false;
  }
  return task.scheduleAfter.getTime() > now.getTime();
}
