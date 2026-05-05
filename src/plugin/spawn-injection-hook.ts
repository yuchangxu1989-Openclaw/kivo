import type { ContextInjector } from '../injection/context-injector.js';

export interface SpawnInjectionHookConfig {
  spawnBudget: number;
  minScore: number;
}

const DEFAULT_CONFIG: SpawnInjectionHookConfig = {
  spawnBudget: 1500,
  minScore: 0.2,
};

export class SpawnInjectionHook {
  private readonly injector: ContextInjector;
  private readonly config: SpawnInjectionHookConfig;

  constructor(injector: ContextInjector, config?: Partial<SpawnInjectionHookConfig>) {
    this.injector = injector;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async handleBeforeToolCall(evt: {
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<void> {
    if (evt.toolName !== 'sessions_spawn') return;

    const task = typeof evt.args.task === 'string' ? evt.args.task : '';
    if (!task.trim()) return;

    const result = await this.injector.inject({
      userQuery: task,
      tokenBudget: this.config.spawnBudget,
      preferredTypes: ['intent', 'decision'],
      disclosureMode: 'summary',
      minScore: this.config.minScore,
    });

    if (!result.injectedContext) return;

    evt.args.task = `${task}\n---\n[KIVO 意图知识参考]\n${result.injectedContext}`;
  }
}
