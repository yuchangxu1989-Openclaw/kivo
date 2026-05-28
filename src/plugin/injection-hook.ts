import type { ContextInjector, InjectionResponse } from '../injection/context-injector.js';

export interface InjectionHookConfig {
  tokenBudget: number;
  minScore: number;
}

const DEFAULT_CONFIG: InjectionHookConfig = {
  tokenBudget: 2000,
  minScore: 0.2,
};

export class InjectionHook {
  private readonly injector: ContextInjector;
  private readonly config: InjectionHookConfig;

  constructor(injector: ContextInjector, config?: Partial<InjectionHookConfig>) {
    this.injector = injector;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async handleBeforePromptBuild(ctx: {
    currentMessage?: string;
    prependSystem: (text: string) => void;
  }): Promise<void> {
    const query = ctx.currentMessage?.trim();
    if (!query) return;

    const result = await this.injector.inject({
      userQuery: query,
      tokenBudget: this.config.tokenBudget,
      preferredTypes: ['intent', 'decision', 'methodology'],
      disclosureMode: 'summary',
      minScore: this.config.minScore,
    });

    if (!result.injectedContext) return;

    const wrapped = `<!-- KIVO Intent Knowledge -->\n${result.injectedContext}\n<!-- /KIVO Intent Knowledge -->`;
    ctx.prependSystem(wrapped);
  }
}
