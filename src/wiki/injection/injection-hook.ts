/**
 * FR-4 AC-4.1, AC-4.2 | NFR-4
 * Gateway plugin hook entry point for automatic wiki knowledge injection.
 * Listens to agent:bootstrap event and injects relevant domain knowledge.
 */

import type { WikiRepository } from '../db/wiki-repository.js';
import type { EmbeddingAdapter } from '../types.js';
import { WikiInjector, type InjectionResult, type WikiInjectorOptions } from './wiki-injector.js';

export interface BootstrapEvent {
  agentId: string;
  sessionId: string;
  /** The user's initial message or task description */
  message: string;
  /** Existing context to append to */
  context: string[];
  /** Metadata about the agent session */
  metadata?: Record<string, unknown>;
}

export interface InjectionHookConfig {
  /** Whether injection is enabled */
  enabled: boolean;
  /** Injector options */
  injectorOptions?: WikiInjectorOptions;
  /** Minimum message length to trigger injection */
  minMessageLength?: number;
  /** Agent IDs to exclude from injection */
  excludeAgents?: string[];
}

const DEFAULT_CONFIG: InjectionHookConfig = {
  enabled: true,
  minMessageLength: 10,
  excludeAgents: [],
};

export interface InjectionHookResult {
  injected: boolean;
  result?: InjectionResult;
  reason?: string;
}

/**
 * Creates the injection hook handler for Gateway plugin registration.
 * Attaches to the `agent:bootstrap` lifecycle event.
 */
export function createInjectionHook(
  repository: WikiRepository,
  embedder: EmbeddingAdapter,
  config: Partial<InjectionHookConfig> = {},
) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const injector = new WikiInjector(repository, embedder, cfg.injectorOptions);

  return {
    name: 'kivo-wiki-injection',
    event: 'agent:bootstrap' as const,

    /**
     * Hook handler invoked on agent bootstrap.
     * Injects relevant wiki knowledge into the agent's context.
     */
    async handler(event: BootstrapEvent): Promise<InjectionHookResult> {
      // Guard: injection disabled
      if (!cfg.enabled) {
        return { injected: false, reason: 'injection_disabled' };
      }

      // Guard: excluded agent
      if (cfg.excludeAgents?.includes(event.agentId)) {
        return { injected: false, reason: 'agent_excluded' };
      }

      // Guard: message too short for meaningful retrieval
      if (event.message.length < (cfg.minMessageLength ?? 10)) {
        return { injected: false, reason: 'message_too_short' };
      }

      // Perform injection
      const result = await injector.inject(event.message);

      // AC-4.7: No hits - still allow normal response
      if (result.noHits) {
        return { injected: false, result, reason: 'no_relevant_knowledge' };
      }

      // Inject rendered context into the agent's context array
      event.context.push(result.rendered);

      return { injected: true, result };
    },
  };
}

/**
 * Plugin manifest for Gateway registration.
 */
export const PLUGIN_MANIFEST = {
  name: 'kivo-wiki-injection',
  version: '1.0.0',
  description: 'Automatic domain knowledge injection from KIVO LLM Wiki',
  hooks: ['agent:bootstrap'],
};
