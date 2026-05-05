/**
 * TermImporter — JSON/YAML/CSV 批量导入 + 导入报告
 * FR-H05
 *
 * 纯 TypeScript 实现，不引入外部 YAML/CSV 库。
 */

import type { KnowledgeSource } from '../types/index.js';
import type { DictionaryService } from './dictionary-service.js';
import type {
  TermRegistrationInput,
  ImportReport,
  ImportDetail,
} from './term-types.js';

export interface TermImporterOptions {
  dictionaryService: DictionaryService;
}

export class TermImporter {
  private readonly service: DictionaryService;

  constructor(options: TermImporterOptions) {
    this.service = options.dictionaryService;
  }

  /** 从文本内容批量导入术语 */
  async importFromContent(
    content: string,
    format: 'json' | 'yaml' | 'csv',
    source: KnowledgeSource,
  ): Promise<ImportReport> {
    const items = this.parse(content, format);
    return this.importItems(items, source);
  }

  /** 从治理文件中解析术语定义并导入 */
  async importFromGovernanceContent(
    content: string,
    source: KnowledgeSource,
    defaultScope: string[] = ['governance'],
  ): Promise<ImportReport> {
    const items = this.parseGovernanceTerms(content, defaultScope);
    return this.importItems(items, source);
  }

  /** 导出术语为指定格式 (P1-2: JSON/YAML/CSV 三格式) */
  async exportTo(format: 'json' | 'yaml' | 'csv', scope?: string): Promise<string> {
    const entries = scope
      ? await this.service.listByScope(scope, 0, 10000)
      : await this.service.queryAllActiveTerms();

    const items: ExportItem[] = entries.map(e => {
      const meta = e.metadata as Record<string, unknown>;
      return {
        term: String(meta?.term ?? e.title),
        definition: String(meta?.definition ?? e.content),
        constraints: toStringArray(meta?.constraints),
        aliases: toStringArray(meta?.aliases),
        positiveExamples: toStringArray(meta?.positiveExamples),
        negativeExamples: toStringArray(meta?.negativeExamples),
        scope: toStringArray(meta?.scope),
      };
    });

    switch (format) {
      case 'json': return JSON.stringify(items, null, 2);
      case 'yaml': return this.toYaml(items);
      case 'csv': return this.toCsv(items);
    }
  }

  /** 导出术语为 JSON 字符串 (向后兼容) */
  async exportToJson(scope?: string): Promise<string> {
    return this.exportTo('json', scope);
  }

  /**
   * 从治理文件（markdown）中解析术语定义并导入
   * FR-H05 AC2：作为文档知识提取（FR-A02）的一种特化策略
   *
   * 支持的 markdown 格式：
   * ## 术语名
   * 定义文本
   * - 约束: xxx
   * - 别名: a, b
   * - 正例: xxx
   * - 负例: xxx
   * - 适用域: scope1, scope2
   */
  async importFromGovernanceDoc(
    content: string,
    source: KnowledgeSource,
  ): Promise<ImportReport> {
    const items = this.parseGovernanceDoc(content);
    return this.importItems(items, source, 'governance');
  }

  private parseGovernanceDoc(content: string): RawTermItem[] {
    const items: RawTermItem[] = [];
    const sections = content.split(/^##\s+/m).filter(s => s.trim());

    for (const section of sections) {
      const lines = section.split('\n');
      const term = lines[0]?.trim();
      if (!term) continue;

      const definitionLines: string[] = [];
      const constraints: string[] = [];
      const aliases: string[] = [];
      const positiveExamples: string[] = [];
      const negativeExamples: string[] = [];
      const scope: string[] = [];

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const bulletMatch = line.match(/^[-*]\s*(.+)$/);
        if (bulletMatch) {
          const bulletContent = bulletMatch[1];
          const kvMatch = bulletContent.match(/^(约束|constraints?|别名|aliases?|正例|positive[_ ]?examples?|负例|negative[_ ]?examples?|适用域|scope)\s*[:\uff1a]\s*(.+)$/i);
          if (kvMatch) {
            const key = kvMatch[1].toLowerCase();
            const value = kvMatch[2].trim();
            const values = value.split(/[,\uff0c]/).map(v => v.trim()).filter(Boolean);

            if (/^(约束|constraints?)/.test(key)) {
              constraints.push(...values);
            } else if (/^(别名|aliases?)/.test(key)) {
              aliases.push(...values);
            } else if (/^(正例|positive)/.test(key)) {
              positiveExamples.push(...values);
            } else if (/^(负例|negative)/.test(key)) {
              negativeExamples.push(...values);
            } else if (/^(适用域|scope)/.test(key)) {
              scope.push(...values);
            }
            continue;
          }
        }

        // 非结构化行视为定义文本
        if (constraints.length === 0 && aliases.length === 0) {
          definitionLines.push(line);
        }
      }

      const definition = definitionLines.join(' ').trim();
      if (!definition) continue;

      items.push({
        term,
        definition,
        constraints,
        aliases,
        positiveExamples,
        negativeExamples,
        scope,
      });
    }

    return items;
  }

  // ── parsing ──

  private parse(content: string, format: 'json' | 'yaml' | 'csv'): RawTermItem[] {
    switch (format) {
      case 'json': return this.parseJson(content);
      case 'yaml': return this.parseYaml(content);
      case 'csv': return this.parseCsv(content);
    }
  }

  private parseJson(content: string): RawTermItem[] {
    const data = JSON.parse(content);
    if (!Array.isArray(data)) throw new Error('JSON input must be an array');
    return data.map(normalizeRawItem);
  }

  /** 简易 YAML 解析器 — 支持列表项格式 */
  private parseYaml(content: string): RawTermItem[] {
    const items: RawTermItem[] = [];
    let current: Record<string, unknown> | null = null;

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trimEnd();
      if (line.trim() === '' || line.trim().startsWith('#')) continue;

      if (line.startsWith('- ')) {
        if (current) items.push(normalizeRawItem(current));
        current = {};
        const rest = line.slice(2).trim();
        if (rest) this.parseYamlKV(rest, current);
        continue;
      }

      if (current && /^\s+/.test(line)) {
        this.parseYamlKV(line.trim(), current);
        continue;
      }

      if (!current) current = {};
      this.parseYamlKV(line.trim(), current);
    }

    if (current) items.push(normalizeRawItem(current));
    return items;
  }

  private parseYamlKV(text: string, target: Record<string, unknown>): void {
    const colonIdx = text.indexOf(':');
    if (colonIdx < 0) return;
    const key = text.slice(0, colonIdx).trim();
    let value: string | unknown = text.slice(colonIdx + 1).trim();

    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = (value as string)
          .slice(1, -1)
          .split(',')
          .map((s: string) => s.trim().replace(/^["']|["']$/g, ''));
      }
    }

    target[key] = value;
  }

  /** CSV 解析器 — 首行为表头 */
  private parseCsv(content: string): RawTermItem[] {
    const lines = content.split('\n').filter(l => l.trim() !== '');
    if (lines.length < 2) return [];

    const headers = this.parseCsvLine(lines[0]);
    const items: RawTermItem[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCsvLine(lines[i]);
      const obj: Record<string, unknown> = {};
      for (let j = 0; j < headers.length; j++) {
        const key = headers[j].trim();
        let val: unknown = values[j]?.trim() ?? '';
        if (typeof val === 'string' && val.startsWith('[')) {
          try { val = JSON.parse(val); } catch { /* keep as string */ }
        }
        obj[key] = val;
      }
      items.push(normalizeRawItem(obj));
    }

    return items;
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }

  private parseGovernanceTerms(content: string, defaultScope: string[]): RawTermItem[] {
    const lines = content.split('\n');
    const items: RawTermItem[] = [];
    let current: Partial<RawTermItem> | null = null;

    const pushCurrent = () => {
      if (!current?.term || !current.definition) return;
      items.push({
        term: current.term,
        definition: current.definition,
        constraints: current.constraints ?? [],
        aliases: current.aliases ?? [],
        positiveExamples: current.positiveExamples ?? [],
        negativeExamples: current.negativeExamples ?? [],
        scope: current.scope?.length ? current.scope : [...defaultScope],
        governanceSource: current.governanceSource,
      });
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        pushCurrent();
        current = null;
        continue;
      }

      const headingMatch = line.match(/^#{1,6}\s*(.+)$/);
      if (headingMatch && /术语|term/i.test(headingMatch[1])) {
        pushCurrent();
        current = {
          term: headingMatch[1].replace(/术语[:：]?/i, '').trim(),
          scope: [...defaultScope],
          governanceSource: 'heading',
        };
        continue;
      }

      const bulletMatch = line.match(/^[-*]\s*(术语|term|定义|definition|约束|constraints|别名|aliases|正例|positiveExamples|负例|negativeExamples|scope|适用域|governanceSource)\s*[:：]\s*(.+)$/i);
      if (bulletMatch) {
        current ??= { scope: [...defaultScope] };
        this.assignGovernanceField(current, bulletMatch[1], bulletMatch[2]);
        continue;
      }

      const pipeMatch = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|?\s*$/);
      if (pipeMatch && !/---/.test(line)) {
        current ??= { scope: [...defaultScope] };
        this.assignGovernanceField(current, pipeMatch[1], pipeMatch[2]);
      }
    }

    pushCurrent();
    return items;
  }

  private assignGovernanceField(current: Partial<RawTermItem>, rawKey: string, rawValue: string): void {
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (!value) return;

    if (key === '术语' || key === 'term') current.term = value;
    else if (key === '定义' || key === 'definition') current.definition = value;
    else if (key === '约束' || key === 'constraints') current.constraints = parseDelimitedValue(value);
    else if (key === '别名' || key === 'aliases') current.aliases = parseDelimitedValue(value);
    else if (key === '正例' || key === 'positiveexamples') current.positiveExamples = parseDelimitedValue(value);
    else if (key === '负例' || key === 'negativeexamples') current.negativeExamples = parseDelimitedValue(value);
    else if (key === 'scope' || key === '适用域') current.scope = parseDelimitedValue(value);
    else if (key === 'governancesource') current.governanceSource = value;
  }

  // ── export serialization ──

  private toYaml(items: ExportItem[]): string {
    return items.map(item => {
      const lines = [
        `- term: ${item.term}`,
        `  definition: ${item.definition}`,
        `  constraints: ${JSON.stringify(item.constraints)}`,
        `  aliases: ${JSON.stringify(item.aliases)}`,
        `  positiveExamples: ${JSON.stringify(item.positiveExamples)}`,
        `  negativeExamples: ${JSON.stringify(item.negativeExamples)}`,
        `  scope: ${JSON.stringify(item.scope)}`,
      ];
      return lines.join('\n');
    }).join('\n');
  }

  private toCsv(items: ExportItem[]): string {
    const headers = ['term', 'definition', 'constraints', 'aliases', 'positiveExamples', 'negativeExamples', 'scope'];
    const lines = [headers.join(',')];
    for (const item of items) {
      const row = [
        this.csvEscape(item.term),
        this.csvEscape(item.definition),
        this.csvEscape(JSON.stringify(item.constraints)),
        this.csvEscape(JSON.stringify(item.aliases)),
        this.csvEscape(JSON.stringify(item.positiveExamples)),
        this.csvEscape(JSON.stringify(item.negativeExamples)),
        this.csvEscape(JSON.stringify(item.scope)),
      ];
      lines.push(row.join(','));
    }
    return lines.join('\n');
  }

  private csvEscape(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  // ── import logic ──

  private async importItems(items: RawTermItem[], source: KnowledgeSource, governanceSource?: string): Promise<ImportReport> {
    const report: ImportReport = {
      total: items.length,
      succeeded: 0,
      conflicted: 0,
      skipped: 0,
      failed: 0,
      details: [],
    };

    for (const item of items) {
      const detail: ImportDetail = { term: item.term, status: 'failed' };

      if (!item.term || !item.definition) {
        detail.status = 'skipped';
        detail.reason = 'Missing required field: term or definition';
        report.skipped++;
        report.details.push(detail);
        continue;
      }

      const input: TermRegistrationInput = {
        term: item.term,
        definition: item.definition,
        constraints: item.constraints,
        aliases: item.aliases,
        positiveExamples: item.positiveExamples,
        negativeExamples: item.negativeExamples,
        scope: item.scope.length > 0 ? item.scope : ['default'],
        source,
        governanceSource: governanceSource ?? item.governanceSource,
      };

      try {
        await this.service.register(input);
        detail.status = 'succeeded';
        report.succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('conflict') || msg.includes('already exists')) {
          detail.status = 'conflicted';
          detail.reason = msg;
          report.conflicted++;
        } else {
          detail.status = 'failed';
          detail.reason = msg;
          report.failed++;
        }
      }

      report.details.push(detail);
    }

    return report;
  }
}

// ── helpers ──

interface ExportItem {
  term: string;
  definition: string;
  constraints: string[];
  aliases: string[];
  positiveExamples: string[];
  negativeExamples: string[];
  scope: string[];
}

interface RawTermItem {
  term: string;
  definition: string;
  constraints: string[];
  aliases: string[];
  positiveExamples: string[];
  negativeExamples: string[];
  scope: string[];
  governanceSource?: string;
}

function normalizeRawItem(obj: Record<string, unknown>): RawTermItem {
  return {
    term: String(obj.term ?? obj.name ?? ''),
    definition: String(obj.definition ?? ''),
    constraints: toStringArray(obj.constraints),
    aliases: toStringArray(obj.aliases),
    positiveExamples: toStringArray(obj.positiveExamples),
    negativeExamples: toStringArray(obj.negativeExamples),
    scope: toStringArray(obj.scope),
    governanceSource: typeof obj.governanceSource === 'string' ? obj.governanceSource : undefined,
  };
}

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string' && val.length > 0) return [val];
  return [];
}

function parseDelimitedValue(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[、,;；|]/).map(item => item.trim()).filter(Boolean);
}
