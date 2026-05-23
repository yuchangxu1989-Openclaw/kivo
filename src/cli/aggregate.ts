import { formatAggregatorResult, runKnowledgeAggregation, type AggregatorResult } from '../pipeline/knowledge-aggregator.js';

export interface AggregateCommandOptions {
  dryRun?: boolean;
  noQualityGate?: boolean;
  json?: boolean;
  maxMaterials?: number;
}

export async function aggregateCommand(options: AggregateCommandOptions = {}): Promise<string> {
  const result = await runKnowledgeAggregation({
    dryRun: options.dryRun,
    skipQualityGate: options.noQualityGate,
    maxMaterials: options.maxMaterials,
    cwd: process.cwd(),
  });

  if (options.json) {
    return JSON.stringify(result, null, 2);
  }

  return formatAggregatorResult(result, !!options.dryRun);
}

export function formatAggregateSummary(result: AggregatorResult): string {
  return `${result.knowledgeWritten} entries written, ${result.materialsConsumed} materials consumed`;
}
