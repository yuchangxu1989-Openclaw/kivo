import type { GapPriority } from './gap-detection-types.js';
import type { ResearchTask } from './research-task-types.js';

export interface SchedulerConfig {
  maxConcurrentResearchTasks: number;
  frequencyMs: number;
  silentMode?: boolean;
  userTaskActive?: boolean;
}

export interface PriorityScore {
  taskId: string;
  score: number;
  impactScore: number;
  urgencyScore: number;
  priority: GapPriority;
  blocking: boolean;
}

export interface ResearchScheduleDecision {
  runnable: ResearchTask[];
  deferred: ResearchTask[];
  skipped: ResearchTask[];
  scores: PriorityScore[];
  nextRunAt: Date | null;
  silentMode: boolean;
  userTaskActive: boolean;
}
