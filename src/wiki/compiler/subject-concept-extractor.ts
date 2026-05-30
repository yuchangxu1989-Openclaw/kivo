/**
 * FR-P04 领域知识自动提取器
 *
 * 输入：一份 material 的文本切片 + 已归类的 subject_node
 * 输出：5 类领域知识条目，写入 entries 表
 *   - 概念 (concept)        → entries.entry_type='concept', type='fact'
 *   - 公式 (formula)        → entries.entry_type='concept', type='fact'，content 含表达式或结构化规则
 *   - 定理 (theorem)        → entries.entry_type='concept', type='fact'
 *   - 例题 (example)        → entries.entry_type='question', type='methodology'
 *   - 关键性质 (property)   → entries.entry_type='concept', type='fact'
 *
 * 通用化设计：禁止硬编码具体学科，prompt 通过 subjectName 动态拼接。
 *
 * Claude Code (OpenClaw ACP Agent) / 2026-05-24
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

import { resolveLlmConfig, type LlmConfig } from '../../cli/resolve-llm-config.js';
import { parsePdfDocument } from '../collection/pdf-parser.js';

const EXTRACTOR_ID = 'subject-concept-extractor-v1';
const DEFAULT_MODEL = 'claude-opus-4-7';

/** 5 类领域知识条目，subject-agnostic：任何学科都能复用 */
export const CONCEPT_KINDS = ['concept', 'formula', 'theorem', 'example', 'property'] as const;
export type ConceptKind = typeof CONCEPT_KINDS[number];

/** 把 5 类映射回 entries.type / entries.entry_type */
const KIND_TO_ENTRY_TYPE: Record<ConceptKind, 'concept' | 'question'> = {
  concept: 'concept',
  formula: 'concept',
  theorem: 'concept',
  example: 'question',
  property: 'concept',
};

const KIND_TO_KNOWLEDGE_TYPE: Record<ConceptKind, 'fact' | 'methodology'> = {
  concept: 'fact',
  formula: 'fact',
  theorem: 'fact',
  example: 'methodology',
  property: 'fact',
};

const KIND_TO_LABEL_ZH: Record<ConceptKind, string> = {
  concept: '概念',
  formula: '公式',
  theorem: '定理',
  example: '例题',
  property: '关键性质',
};

const MAX_CHUNK_CHARS = 4_000;
const MAX_ITEMS_PER_CHUNK = 20;
const REQUEST_TIMEOUT_MS = 180_000;

export interface ExtractedConceptItem {
  kind: ConceptKind;
  title: string;
  content: string;
  summary: string;
  /** 来源页 / 段（可选，由 LLM 复述） */
  sourcePage?: number;
  /** 关联术语，用于后续构图 */
  relatedTerms: string[];
}

export interface MaterialChunkInput {
  /** 切片序号，用于日志和 source_json */
  index: number;
  /** 切片文本（已限长） */
  text: string;
  /** 来源页（如果可知） */
  page?: number;
}

export interface SubjectConceptExtractorOptions {
  /** 自定义 LlmConfig；不传则走 resolveLlmConfig */
  llm?: LlmConfig;
  /** 模型名（默认 claude-opus-4-7） */
  model?: string;
  /** 自定义 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /** 调试日志 */
  verbose?: boolean;
}

export interface ExtractFromMaterialResult {
  materialId: string;
  subjectId: string;
  chunkCount: number;
  itemsExtracted: number;
  entriesWritten: number;
  errors: string[];
}

/**
 * 通用领域知识提取器
 *
 * 不做任何主题假设：所有特定领域信息必须通过 subjectName 进入 prompt，
 * 不允许在代码里按具体主题做 if 分支。
 */
export class SubjectConceptExtractor {
  private readonly db: Database.Database;
  private readonly llm: LlmConfig;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly verbose: boolean;

  constructor(dbPath: string, options: SubjectConceptExtractorOptions = {}) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    if (options.llm) {
      this.llm = options.llm;
    } else {
      const resolved = resolveLlmConfig();
      if ('error' in resolved) {
        throw new Error(`LLM config error: ${resolved.error}`);
      }
      this.llm = resolved;
    }
    this.model = options.model ?? this.llm.model ?? DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.verbose = !!options.verbose;
  }

  close(): void {
    this.db.close();
  }

  /** 公开：从一组 chunks 提取（测试入口，不需要 DB 写入） */
  async extractFromChunks(
    subjectName: string,
    chunks: MaterialChunkInput[],
  ): Promise<ExtractedConceptItem[]> {
    const items: ExtractedConceptItem[] = [];
    for (const chunk of chunks) {
      try {
        const chunkItems = await this.extractOneChunk(subjectName, chunk);
        items.push(...chunkItems);
      } catch (error) {
        if (this.verbose) {
          console.error(`[concept-extract] chunk=${chunk.index} failed: ${(error as Error).message}`);
        }
      }
    }
    return items;
  }

  /**
   * 主入口：处理一份 material（已归类到某 subject）
   *  1. 读取 material 文本（先尝试已有 entries → 失败回退 PDF 重 slice）
   *  2. 拆 chunks 调 LLM
   *  3. 落 entries 表（带 subject_id + materialId）
   */
  async extractFromMaterial(materialId: string): Promise<ExtractFromMaterialResult> {
    const material = this.getMaterial(materialId);
    if (!material) {
      throw new Error(`material not found: ${materialId}`);
    }
    if (!material.subject_node_id) {
      throw new Error(`material ${materialId} has no subject_node_id; classify first`);
    }
    const subject = this.getSubjectName(material.subject_node_id);
    if (!subject) {
      throw new Error(`subject_node ${material.subject_node_id} not found`);
    }

    const chunks = await this.loadMaterialChunks(material);
    const result: ExtractFromMaterialResult = {
      materialId,
      subjectId: material.subject_node_id,
      chunkCount: chunks.length,
      itemsExtracted: 0,
      entriesWritten: 0,
      errors: [],
    };

    if (chunks.length === 0) {
      result.errors.push('no chunks available (slice empty + pdf re-slice failed)');
      return result;
    }

    // FR-P04 rewrite: domain extraction disabled (stop-the-bleed).
    // 领域材料提取管线产出的「概念/公式/定理/例题/性质」与 FR-A07 意图知识定义正面冲突，
    // 且无下游真实消费，治理引擎每轮都要回收它灌进 entries 表的噪音。
    // 在重写为独立领域知识库（独立表 + 独立质量门禁）之前，禁止它直接写 entries 表。
    // 重新启用：把下面这个常量改回 false 即可恢复原 INSERT 逻辑。
    const DOMAIN_EXTRACTION_DISABLED: boolean = true;
    if (DOMAIN_EXTRACTION_DISABLED) {
      console.warn(
        `[subject-concept-extractor] domain extraction disabled per FR-P04 rewrite; ` +
          `skipping INSERT for material=${materialId} (chunks=${chunks.length}). ` +
          `No entries written until domain knowledge store is rebuilt.`,
      );
      result.errors.push('domain extraction disabled per FR-P04 rewrite (no entries written)');
      return result;
    }

    const insertEntry = this.db.prepare(`
      INSERT INTO entries (
        id, type, title, content, summary, source_json, confidence, status,
        tags_json, created_at, updated_at, version, metadata_json,
        subject_id, entry_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 1, ?, ?, ?)
    `);

    for (const chunk of chunks) {
      let chunkItems: ExtractedConceptItem[];
      try {
        chunkItems = await this.extractOneChunk(subject, chunk);
      } catch (error) {
        result.errors.push(`chunk=${chunk.index}: ${(error as Error).message}`);
        continue;
      }

      result.itemsExtracted += chunkItems.length;
      const now = new Date().toISOString();

      const tx = this.db.transaction((items: ExtractedConceptItem[]) => {
        for (const item of items) {
          const sourceJson = JSON.stringify({
            extractor: EXTRACTOR_ID,
            extractor_model: this.model,
            materialId,
            materialName: material.file_name,
            chunkIndex: chunk.index,
            page: item.sourcePage ?? chunk.page ?? null,
            relatedTerms: item.relatedTerms,
            kind: item.kind,
          });
          const metadataJson = JSON.stringify({
            extractor: EXTRACTOR_ID,
            kindLabel: KIND_TO_LABEL_ZH[item.kind],
            subjectName: subject,
          });
          insertEntry.run(
            randomUUID(),
            KIND_TO_KNOWLEDGE_TYPE[item.kind],
            item.title.slice(0, 120),
            item.content,
            item.summary.slice(0, 240),
            sourceJson,
            0.7,
            JSON.stringify([subject, KIND_TO_LABEL_ZH[item.kind], 'subject-concept']),
            now,
            now,
            metadataJson,
            material.subject_node_id,
            KIND_TO_ENTRY_TYPE[item.kind],
          );
          result.entriesWritten += 1;
        }
      });
      tx(chunkItems);
    }

    // 更新 materials.extract_count
    this.db.prepare(
      `UPDATE materials SET extract_count = COALESCE(extract_count, 0) + ?, updated_at = ? WHERE id = ?`,
    ).run(result.entriesWritten, new Date().toISOString(), materialId);

    return result;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private getMaterial(materialId: string): {
    id: string;
    file_name: string;
    subject_node_id: string | null;
    storage_path: string;
    mime_type: string;
  } | null {
    const row = this.db.prepare(`
      SELECT id, file_name, subject_node_id, storage_path, mime_type
      FROM materials WHERE id = ?
    `).get(materialId) as {
      id: string;
      file_name: string;
      subject_node_id: string | null;
      storage_path: string;
      mime_type: string;
    } | undefined;
    return row ?? null;
  }

  private getSubjectName(subjectId: string): string | null {
    const row = this.db.prepare(`SELECT name FROM subject_nodes WHERE id = ?`).get(subjectId) as
      | { name: string }
      | undefined;
    return row?.name ?? null;
  }

  /**
   * 取这份 material 可用的 chunks。
   * 策略：
   *   1. 如果 entries 表里已经有这个 materialId 的旧条目（auto-pipeline 老链路产物）→ 用 content 反向当 chunk
   *   2. 否则，如果 storage_path 是 PDF 且文件存在 → 重新 parsePdf 按页切
   *   3. 都失败返回空（调用方记 error）
   */
  private async loadMaterialChunks(material: {
    id: string;
    storage_path: string;
    mime_type: string;
    file_name: string;
  }): Promise<MaterialChunkInput[]> {
    // 优先：从已有的旧 wiki_page entry 里取 source 文本（如果存在）
    const oldEntries = this.db.prepare(`
      SELECT content FROM entries
      WHERE type IN ('fact','methodology','decision','experience')
        AND json_extract(source_json,'$.materialId') = ?
        AND COALESCE(status,'active') != 'deleted'
      ORDER BY created_at ASC
    `).all(material.id) as Array<{ content: string }>;

    if (oldEntries.length >= 5) {
      // 已有提取过的条目：把 content 重新拼回作为 chunks（每 5 条合一段）
      const buckets: string[][] = [];
      let bucket: string[] = [];
      for (const row of oldEntries) {
        bucket.push(row.content);
        if (bucket.join('\n').length > MAX_CHUNK_CHARS - 200 || bucket.length >= 5) {
          buckets.push(bucket);
          bucket = [];
        }
      }
      if (bucket.length > 0) buckets.push(bucket);
      return buckets.map((items, index) => ({
        index,
        text: items.join('\n\n').slice(0, MAX_CHUNK_CHARS),
      }));
    }

    // 回退：重新解析 PDF
    if (material.mime_type !== 'application/pdf') {
      return [];
    }
    if (!material.storage_path || !existsSync(material.storage_path)) {
      return [];
    }
    try {
      const data = readFileSync(material.storage_path);
      const parsed = await parsePdfDocument(new Uint8Array(data));
      const chunks: MaterialChunkInput[] = [];
      let buffer: { pages: number[]; text: string } = { pages: [], text: '' };
      for (const page of parsed.pages) {
        if (page.text.length === 0) continue;
        if ((buffer.text + '\n' + page.text).length > MAX_CHUNK_CHARS && buffer.text) {
          chunks.push({
            index: chunks.length,
            page: buffer.pages[0],
            text: buffer.text.slice(0, MAX_CHUNK_CHARS),
          });
          buffer = { pages: [], text: '' };
        }
        buffer.pages.push(page.pageNumber);
        buffer.text = buffer.text ? `${buffer.text}\n\n${page.text}` : page.text;
      }
      if (buffer.text) {
        chunks.push({
          index: chunks.length,
          page: buffer.pages[0],
          text: buffer.text.slice(0, MAX_CHUNK_CHARS),
        });
      }
      return chunks;
    } catch (error) {
      if (this.verbose) {
        console.error(`[concept-extract] PDF parse failed: ${(error as Error).message}`);
      }
      return [];
    }
  }

  private async extractOneChunk(
    subjectName: string,
    chunk: MaterialChunkInput,
  ): Promise<ExtractedConceptItem[]> {
    const systemPrompt = this.buildSystemPrompt(subjectName);
    const userPrompt = this.buildUserPrompt(subjectName, chunk);

    const raw = await this.callLlm(systemPrompt, userPrompt);
    return this.parseLlmResponse(raw);
  }

  private buildSystemPrompt(subjectName: string): string {
    return [
      `你是 KIVO 的领域知识提取器。当前学科：${subjectName}。`,
      '你的任务是从输入的学科材料文本里，按 5 类提取知识条目：',
      `- concept（概念）：${subjectName} 中的术语定义、对象、范畴。`,
      `- formula（公式）：${subjectName} 中带符号的公式、表达式或结构化规则（必须保留原始表示或文字描述）。`,
      `- theorem（定理）：${subjectName} 中带"前提-结论"结构的命题、定理、推论。`,
      `- example（例题）：${subjectName} 中给出"题面 + 解法"或"题面 + 答案"的例题、习题、真题。`,
      `- property（关键性质）：${subjectName} 中对象的性质、特征、约束、必要条件。`,
      '硬约束：',
      '1. 只能基于输入文本，不要杜撰。',
      '2. 输出的 title / content / summary 必须是中文。',
      '3. content 必须是抽象后的、可复用的知识，不是流水账复述。',
      '4. example 类必须包含完整题面，content 至少含「题：…解：…」结构。',
      '5. formula 类必须保留公式本体；纯文字推导写成 theorem 或 property。',
      '6. 如果 chunk 不是学科正文（目录、版权页、作者前言），返回空数组。',
      '严格输出 JSON 数组（不要 markdown 代码块）：',
      '[{"kind":"concept|formula|theorem|example|property","title":"...","content":"...","summary":"...","sourcePage":可选数字,"relatedTerms":["..."]}]',
      `单次最多输出 ${MAX_ITEMS_PER_CHUNK} 条。`,
    ].join('\n');
  }

  private buildUserPrompt(subjectName: string, chunk: MaterialChunkInput): string {
    const lines: string[] = [];
    lines.push(`subject: ${subjectName}`);
    lines.push(`chunk_index: ${chunk.index}`);
    if (chunk.page !== undefined) lines.push(`page: ${chunk.page}`);
    lines.push('');
    lines.push('--- 材料文本 ---');
    lines.push(chunk.text);
    lines.push('--- 结束 ---');
    lines.push('');
    lines.push('请按系统指令输出 JSON 数组。');
    return lines.join('\n');
  }

  private async callLlm(system: string, user: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.llm.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          max_tokens: 6000,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      const parsed = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = parsed.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('LLM empty content');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseLlmResponse(raw: string): ExtractedConceptItem[] {
    let body = raw.trim();
    if (body.startsWith('```')) {
      body = body.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Try to find a JSON array inside the text
      const match = body.match(/\[[\s\S]*\]/);
      if (!match) return [];
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return [];
      }
    }
    if (!Array.isArray(parsed)) return [];

    const items: ExtractedConceptItem[] = [];
    for (const raw of parsed) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const kind = String(r.kind ?? '').toLowerCase();
      if (!CONCEPT_KINDS.includes(kind as ConceptKind)) continue;
      const title = typeof r.title === 'string' ? r.title.trim() : '';
      const content = typeof r.content === 'string' ? r.content.trim() : '';
      if (!title || !content) continue;
      const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
      const sourcePage = typeof r.sourcePage === 'number' ? r.sourcePage : undefined;
      const relatedTerms = Array.isArray(r.relatedTerms)
        ? r.relatedTerms
            .map((term) => (typeof term === 'string' ? term.trim() : ''))
            .filter((term) => term.length > 0)
            .slice(0, 10)
        : [];
      items.push({
        kind: kind as ConceptKind,
        title,
        content,
        summary: summary || `${KIND_TO_LABEL_ZH[kind as ConceptKind]}：${title}`,
        sourcePage,
        relatedTerms,
      });
    }
    return items.slice(0, MAX_ITEMS_PER_CHUNK);
  }
}
