/**
 * JsonExporter — 异步导出 JSON 视图（调试/审查用，不作为主存储）
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KnowledgeEntry } from '../types/index.js';
import type { KnowledgeRepository } from './knowledge-repository.js';

export interface JsonExportOptions {
  outputPath: string;
  pretty?: boolean;
}

export class JsonExporter {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly options: JsonExportOptions
  ) {}

  async export(): Promise<void> {
    const count = await this.repository.count();
    // For 万级条目 scale, full export is acceptable
    const allEntries: KnowledgeEntry[] = [];

    // Export by type to avoid loading everything at once
    const types = ['fact', 'methodology', 'decision', 'experience', 'intent', 'meta'] as const;
    for (const type of types) {
      const typed = await this.repository.findByType(type);
      allEntries.push(...typed);
    }

    const output = {
      exportedAt: new Date().toISOString(),
      totalEntries: allEntries.length,
      entries: allEntries,
    };

    await mkdir(dirname(this.options.outputPath), { recursive: true });
    const json = this.options.pretty
      ? JSON.stringify(output, null, 2)
      : JSON.stringify(output);
    await writeFile(this.options.outputPath, json, 'utf-8');
  }
}
