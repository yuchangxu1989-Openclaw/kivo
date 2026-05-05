import Database from 'better-sqlite3';
import type { LLMProvider } from '../adapter/llm-provider.js';
import type { EmbeddingProvider } from '../embedding/embedding-provider.js';
import { ContextInjector } from '../injection/context-injector.js';
import { SignalDetector } from '../intent-signal/signal-detector.js';
import type { IntentSignalType } from '../intent-signal/signal-types.js';
import { KnowledgeRepository } from '../repository/index.js';
import { SQLiteProvider } from '../repository/sqlite-provider.js';
import { PersistentVectorIndex } from '../search/persistent-vector-index.js';
import { SemanticSearch } from '../search/semantic-search.js';
import type { KnowledgeEntry } from '../types/index.js';
import { ConversationCollector } from './conversation-collector.js';
import { InjectionHook } from './injection-hook.js';
import { SpawnInjectionHook } from './spawn-injection-hook.js';

export interface KivoIntentPluginConfig {
  enabled: boolean;
  dbPath: string;
  signalThreshold: number;
  injectionTokenBudget: number;
  spawnInjectionBudget: number;
  enabledSignalTypes: IntentSignalType[];
  maxSignalsPerConversation: number;
  minInjectionScore: number;
  singleAgentMode: 'auto' | 'single' | 'multi';
}

const DEFAULT_CONFIG: KivoIntentPluginConfig = {
  enabled: true,
  dbPath: 'kivo.db',
  signalThreshold: 0.6,
  injectionTokenBudget: 2000,
  spawnInjectionBudget: 1500,
  enabledSignalTypes: ['correction', 'emphasis', 'declaration', 'rule', 'preference'],
  maxSignalsPerConversation: 5,
  minInjectionScore: 0.2,
  singleAgentMode: 'auto',
};

export interface KivoIntentPluginDeps {
  llmProvider: LLMProvider;
  embeddingProvider: EmbeddingProvider;
  config?: Partial<KivoIntentPluginConfig>;
}

export interface HookRegistrar {
  on(event: string, priority: number, handler: (...args: unknown[]) => Promise<void>): void;
}

export function createKivoIntentPlugin(deps: KivoIntentPluginDeps) {
  const config = { ...DEFAULT_CONFIG, ...deps.config };
  if (!config.enabled) {
    return { register: () => {} };
  }

  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  const vectorIndex = new PersistentVectorIndex({ db });
  const sqliteProvider = new SQLiteProvider({ dbPath: config.dbPath, configDir: process.cwd() });
  const repository = new KnowledgeRepository(sqliteProvider);
  const semanticSearch = new SemanticSearch(deps.embeddingProvider, vectorIndex);

  const injector = new ContextInjector({
    repository,
    defaultTopK: 10,
  });

  const signalDetector = new SignalDetector({
    llmProvider: deps.llmProvider,
    config: {
      threshold: config.signalThreshold,
      enabledTypes: config.enabledSignalTypes,
      maxSignalsPerConversation: config.maxSignalsPerConversation,
    },
  });

  const onEntries = async (entries: KnowledgeEntry[]) => {
    for (const entry of entries) {
      const saved = await repository.save(entry);
      if (!saved) continue;
      await semanticSearch.indexEntry(entry);
    }
  };

  const collector = new ConversationCollector({ signalDetector, onEntries });
  const injectionHook = new InjectionHook(injector, {
    tokenBudget: config.injectionTokenBudget,
    minScore: config.minInjectionScore,
  });
  const spawnHook = new SpawnInjectionHook(injector, {
    spawnBudget: config.spawnInjectionBudget,
    minScore: config.minInjectionScore,
  });

  return {
    register(hooks: HookRegistrar) {
      hooks.on('subagent_ended', 300, async (...args: unknown[]) => {
        try {
          const evt = (args[0] ?? {}) as Record<string, unknown>;
          await collector.handleSubagentEnded(evt as Parameters<typeof collector.handleSubagentEnded>[0]);
        } catch { /* fail-open */ }
      });

      hooks.on('session_ended', 300, async (...args: unknown[]) => {
        try {
          const evt = (args[0] ?? {}) as Record<string, unknown>;
          await collector.handleSessionEnded(evt as Parameters<typeof collector.handleSessionEnded>[0]);
        } catch { /* fail-open */ }
      });

      hooks.on('before_prompt_build', 100, async (...args: unknown[]) => {
        try {
          const ctx = (args[0] ?? {}) as Parameters<typeof injectionHook.handleBeforePromptBuild>[0];
          await injectionHook.handleBeforePromptBuild(ctx);
        } catch { /* fail-open */ }
      });

      hooks.on('before_tool_call', 900, async (...args: unknown[]) => {
        try {
          const evt = (args[0] ?? {}) as Parameters<typeof spawnHook.handleBeforeToolCall>[0];
          await spawnHook.handleBeforeToolCall(evt);
        } catch { /* fail-open */ }
      });
    },

    async close() {
      await repository.close();
      db.close();
    },
  };
}

export type KivoIntentPlugin = ReturnType<typeof createKivoIntentPlugin>;

export { ConversationCollector } from './conversation-collector.js';
export { InjectionHook } from './injection-hook.js';
export { SpawnInjectionHook } from './spawn-injection-hook.js';
export { SignalDetector } from '../intent-signal/signal-detector.js';
export { PersistentVectorIndex } from '../search/persistent-vector-index.js';
export type { IntentSignal, IntentSignalType, SignalDetectorConfig } from '../intent-signal/signal-types.js';
