export type ComponentName = 'sqlite' | 'embedding' | 'llm' | 'research-executor';

export interface ComponentStatus {
  name: ComponentName;
  available: boolean;
  hint?: string;
}

export interface SystemCapabilities {
  components: ComponentStatus[];
  searchMode: 'semantic' | 'keyword';
  conflictDetection: 'full' | 'keyword-only';
  researchExecution: 'auto' | 'manual-only';
}

export function detectCapabilities(config: {
  embedding?: unknown;
  embeddingProvider?: unknown;
  llmProvider?: unknown;
}): SystemCapabilities {
  const components: ComponentStatus[] = [];

  const hasEmbedding = !!(config.embedding || config.embeddingProvider);
  components.push({
    name: 'embedding',
    available: hasEmbedding,
    hint: hasEmbedding ? undefined : 'Configure embedding provider for semantic search.',
  });

  const hasLlm = !!config.llmProvider;
  components.push({
    name: 'llm',
    available: hasLlm,
    hint: hasLlm ? undefined : 'Add LLM provider for conflict detection.',
  });

  components.push({ name: 'sqlite', available: true });

  components.push({
    name: 'research-executor',
    available: false,
    hint: 'Research tasks can be created and queued. Manual trigger required.',
  });

  return {
    components,
    searchMode: hasEmbedding ? 'semantic' : 'keyword',
    conflictDetection: hasLlm ? 'full' : 'keyword-only',
    researchExecution: 'manual-only',
  };
}

export function formatCapabilities(caps: SystemCapabilities): string {
  const lines: string[] = ['KIVO System Capabilities', '-'.repeat(35), ''];

  lines.push(`Search mode: ${caps.searchMode}`);
  lines.push(`Conflict detection: ${caps.conflictDetection}`);
  lines.push(`Research execution: ${caps.researchExecution}`);
  lines.push('');

  for (const c of caps.components) {
    const icon = c.available ? '[ON]' : '[OFF]';
    lines.push(`${icon} ${c.name}`);
    if (c.hint) {
      lines.push(`     ${c.hint}`);
    }
  }

  return lines.join('\n');
}
