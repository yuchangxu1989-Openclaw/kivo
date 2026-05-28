/**
 * FR-P06 Wiki 页面编译器
 *
 * 输入：subject_node_id + 关联 entries/materials/graph_edges
 * 输出：entries.type='wiki_page' 的编译型页面
 *
 * Codex (OpenClaw ACP Agent) / 2026-05-24
 */

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

import { resolveLlmConfig, type LlmConfig } from '../../cli/resolve-llm-config.js';
import { initializeWikiSchema } from '../db/schema.js';

const MODEL = 'claude-opus-4-7';
const COMPILER_ID = 'wiki-page-compiler-v2';
const BUCKET_COMPILER_ID = 'wiki-page-compiler-bucket-v1';
const ATOMIC_ENTRY_TYPES = ['fact', 'methodology', 'decision', 'experience'] as const;
const SECTION_ORDER = ['核心概念', '关键方法', '典型题', '易错点', '批注'] as const;

/** FR-P06 子页面分桶：按 entry_type 拆成 5 个分页 */
const BUCKET_DEFINITIONS = [
  { key: 'concept', labelZh: '概念' },
  { key: 'formula', labelZh: '公式' },
  { key: 'theorem', labelZh: '定理' },
  { key: 'example', labelZh: '例题' },
  { key: 'property', labelZh: '关键性质' },
] as const;
type BucketKey = typeof BUCKET_DEFINITIONS[number]['key'];
const REPRESENTATIVE_LIMIT_PER_BUCKET = 10;
const RELATION_SAMPLE_LIMIT = 24;

type AtomicEntryType = typeof ATOMIC_ENTRY_TYPES[number];

interface SubjectNodeRecord {
  id: string;
  parent_id: string | null;
  name: string;
  level: number | null;
  status: string | null;
}

interface MaterialRecord {
  id: string;
  file_name: string;
  subject_node_id: string | null;
  suggested_subject_name: string | null;
  pipeline_status: string | null;
  status: string | null;
}

export interface EntryRecord {
  id: string;
  type: AtomicEntryType;
  title: string;
  content: string;
  summary: string | null;
  source_json: string;
  subject_id: string | null;
  metadata_json: string | null;
  updated_at: string | null;
}

interface GraphRelationRecord {
  source_id: string;
  target_id: string;
  association_type: string;
  weight: number;
}

interface SubjectScope {
  subject: SubjectNodeRecord;
  parent: SubjectNodeRecord | null;
  children: SubjectNodeRecord[];
  descendantIds: string[];
  entries: EntryRecord[];
  materials: MaterialRecord[];
  relations: GraphRelationRecord[];
}

export interface WikiSection {
  label: string;
  entryIds: string[];
  markdown: string;
}

export interface WikiLink {
  sourcePageId: string;
  targetPageId: string | null;
  targetTitle: string;
  label: string;
}

export interface CompiledWikiPage {
  pageId: string;
  subjectId: string;
  title: string;
  markdownBody: string;
  summary: string;
  sectionsJson: WikiSection[];
  entryIds: string[];
  materialIds: string[];
  links: WikiLink[];
}

export interface CompileResultItem {
  subjectId: string;
  title: string;
  pageId: string;
  entryCount: number;
  materialCount: number;
}

export interface CompileResult {
  pagesCreated: number;
  pagesUpdated: number;
  linksCreated: number;
  items: CompileResultItem[];
  errors: string[];
}

interface LlmCompilePayload {
  title?: string;
  summary?: string;
  markdown?: string;
}

async function callLlm(config: LlmConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 9000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const content = parsed.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('LLM returned empty content');
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson<T>(raw: string): T {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    return JSON.parse(cleaned) as T;
  }
  return JSON.parse(trimmed) as T;
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

function safeMarkdown(raw: string | null | undefined): string {
  return (raw ?? '').trim();
}

function trimForPrompt(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapTypeToSection(type: AtomicEntryType): typeof SECTION_ORDER[number] {
  switch (type) {
    case 'fact':
      return '核心概念';
    case 'methodology':
      return '关键方法';
    case 'experience':
      return '典型题';
    case 'decision':
      return '易错点';
  }
}

function renderHeadingLink(label: string): string {
  return `- [${label}](#${label})`;
}

function stripMarkdown(raw: string): string {
  return raw
    .replace(/^#+\s+/gm, '')
    .replace(/[`*_>~-]/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export class WikiPageCompiler {
  readonly db: Database.Database;
  readonly llmConfig: LlmConfig;

  constructor(dbPath: string, llmConfig?: LlmConfig) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    initializeWikiSchema(this.db, { enableForeignKeys: false, busyTimeoutMs: 5000 });

    if (llmConfig) {
      this.llmConfig = llmConfig;
      return;
    }

    const resolved = resolveLlmConfig();
    if ('error' in resolved) {
      throw new Error(`LLM config error: ${resolved.error}`);
    }
    this.llmConfig = resolved;
  }

  close(): void {
    this.db.close();
  }

  listActiveSubjectIds(): string[] {
    const rows = this.db.prepare(`
      SELECT id
      FROM subject_nodes
      WHERE COALESCE(status, 'active') = 'active' AND merged_into IS NULL
      ORDER BY level ASC, name ASC
    `).all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  getEntriesCount(subjectId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM entries
      WHERE subject_id = ?
        AND type IN (${ATOMIC_ENTRY_TYPES.map(() => '?').join(', ')})
        AND COALESCE(status, 'active') != 'deleted'
    `).get(subjectId, ...ATOMIC_ENTRY_TYPES) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  ensureCompiledPageShells(subjectIds: string[]): number {
    let created = 0;
    const insertShell = this.db.prepare(`
      INSERT INTO entries (
        id, type, title, content, summary, source_json, status, tags_json,
        version, metadata_json, subject_id, parent_id, sort_order, created_at, updated_at
      ) VALUES (?, 'wiki_page', ?, '', '', ?, 'active', '[]', 1, ?, ?, NULL, 0, ?, ?)
    `);

    const tx = this.db.transaction((ids: string[]) => {
      for (const subjectId of ids) {
        const subject = this.getSubjectNode(subjectId);
        if (!subject) continue;
        const existing = this.findCompiledPageId(subject.id);
        if (existing) continue;
        const ts = nowIso();
        insertShell.run(
          randomUUID(),
          subject.name,
          JSON.stringify({
            compiler: COMPILER_ID,
            subject_node_id: subject.id,
            related_entry_ids: [],
            related_material_ids: [],
            compiled_at: null,
          }),
          JSON.stringify({
            compiler: COMPILER_ID,
            compilerModel: MODEL,
            subjectNodeId: subject.id,
          }),
          subject.id,
          ts,
          ts,
        );
        created += 1;
      }
    });

    tx(subjectIds);
    return created;
  }

  async compileForSubject(subjectId: string): Promise<CompiledWikiPage> {
    const scope = this.collectSubjectScope(subjectId);
    if (!scope) {
      throw new Error(`subject_node not found: ${subjectId}`);
    }

    const pageId = this.findCompiledPageId(subjectId);
    if (!pageId) {
      throw new Error(`compiled page shell missing for subject_node_id=${subjectId}`);
    }

    const payload = await this.compileMarkdown(scope);
    const sections = this.extractSections(payload.markdown, scope.entries);
    const links = this.buildWikiLinks(pageId, scope);
    const compiled: CompiledWikiPage = {
      pageId,
      subjectId: scope.subject.id,
      title: scope.subject.name,
      markdownBody: payload.markdown,
      summary: payload.summary,
      sectionsJson: sections,
      entryIds: scope.entries.map((entry) => entry.id),
      materialIds: scope.materials.map((material) => material.id),
      links,
    };

    this.persistCompiledPage(compiled, scope);
    return compiled;
  }

  async compileSubjects(subjectIds: string[]): Promise<CompileResult> {
    const uniqueIds = Array.from(new Set(subjectIds));
    const eligibleIds: string[] = [];
    for (const subjectId of uniqueIds) {
      const entriesCount = this.getEntriesCount(subjectId);
      if (entriesCount === 0) {
        console.log(`[wiki-compiler] skip subject=${subjectId}: entries=0`);
        continue;
      }
      eligibleIds.push(subjectId);
    }

    const pagesCreated = this.ensureCompiledPageShells(eligibleIds);
    const result: CompileResult = {
      pagesCreated,
      pagesUpdated: 0,
      linksCreated: 0,
      items: [],
      errors: [],
    };

    for (const subjectId of eligibleIds) {
      try {
        const page = await this.compileForSubject(subjectId);
        result.pagesUpdated += 1;
        result.linksCreated += page.links.length;
        result.items.push({
          subjectId,
          title: page.title,
          pageId: page.pageId,
          entryCount: page.entryIds.length,
          materialCount: page.materialIds.length,
        });
      } catch (error) {
        result.errors.push(`subject=${subjectId}: ${(error as Error).message}`);
      }
    }

    return result;
  }

  async compileAll(): Promise<CompileResult> {
    return this.compileSubjects(this.listActiveSubjectIds());
  }

  private getSubjectNode(subjectId: string): SubjectNodeRecord | null {
    return (
      (this.db.prepare(`
        SELECT id, parent_id, name, level, status
        FROM subject_nodes
        WHERE id = ?
      `).get(subjectId) as SubjectNodeRecord | undefined) ?? null
    );
  }

  private collectSubjectScope(subjectId: string): SubjectScope | null {
    const subject = this.getSubjectNode(subjectId);
    if (!subject) return null;

    const descendantRows = this.db.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM subject_nodes WHERE id = ?
        UNION ALL
        SELECT sn.id
        FROM subject_nodes sn
        JOIN subtree st ON sn.parent_id = st.id
        WHERE COALESCE(sn.status, 'active') = 'active'
      )
      SELECT id FROM subtree
    `).all(subjectId) as Array<{ id: string }>;
    const descendantIds = descendantRows.map((row) => row.id);
    const placeholders = descendantIds.map(() => '?').join(', ');

    const entries = descendantIds.length === 0
      ? []
      : (this.db.prepare(`
          SELECT id, type, title, content, summary, source_json, subject_id, metadata_json, updated_at
          FROM entries
          WHERE subject_id IN (${placeholders})
            AND type IN (${ATOMIC_ENTRY_TYPES.map(() => '?').join(', ')})
            AND COALESCE(status, 'active') != 'deleted'
          ORDER BY updated_at DESC, title ASC
        `).all(...descendantIds, ...ATOMIC_ENTRY_TYPES) as EntryRecord[]);

    const materials = descendantIds.length === 0
      ? []
      : (this.db.prepare(`
          SELECT id, file_name, subject_node_id, suggested_subject_name, pipeline_status, status
          FROM materials
          WHERE subject_node_id IN (${placeholders})
          ORDER BY created_at DESC, file_name ASC
        `).all(...descendantIds) as MaterialRecord[]);

    const entryIds = entries.map((entry) => entry.id);
    const relations = entryIds.length < 2
      ? []
      : (this.db.prepare(`
          SELECT source_id, target_id, association_type, weight
          FROM graph_edges
          WHERE source_id IN (${entryIds.map(() => '?').join(', ')})
            AND target_id IN (${entryIds.map(() => '?').join(', ')})
          ORDER BY weight DESC, id ASC
          LIMIT ?
        `).all(...entryIds, ...entryIds, RELATION_SAMPLE_LIMIT) as GraphRelationRecord[]);

    const parent = subject.parent_id ? this.getSubjectNode(subject.parent_id) : null;
    const children = this.db.prepare(`
      SELECT id, parent_id, name, level, status
      FROM subject_nodes
      WHERE parent_id = ? AND COALESCE(status, 'active') = 'active' AND merged_into IS NULL
      ORDER BY name ASC
    `).all(subject.id) as SubjectNodeRecord[];

    return {
      subject,
      parent,
      children,
      descendantIds,
      entries,
      materials,
      relations,
    };
  }

  private async compileMarkdown(scope: SubjectScope): Promise<{ markdown: string; summary: string }> {
    const prompt = this.buildCompilePrompt(scope);
    const system = [
      '你是 KIVO 的 Wiki 页面编译器。',
      '把同一学科节点下的原子知识条目编译成一个 markdown 风格的 wiki 页面。',
      '必须严格输出 JSON 对象：{"summary":"...","markdown":"..."}。',
      'markdown 必须包含且只保留以下一级结构顺序：',
      '# 标题',
      '## 核心概念',
      '## 关键方法',
      '## 典型题',
      '## 易错点',
      '## 批注',
      '## 关联主题',
      '## 来源溯源',
      '要求：',
      '1. 只基于输入事实，不要杜撰公式、结论、来源页码。',
      '2. 如果某节没有足够条目，明确写“暂无相关条目”。',
      '3. 页面是编译产物，语气客观，不写提示词说明。',
      '4. 用中文，结构清楚，允许项目符号和短段落。',
      '5. 来源溯源节至少列出材料名和对应 entry 标题。',
    ].join('\n');

    try {
      const raw = await callLlm(this.llmConfig, system, prompt);
      const parsed = parseJson<LlmCompilePayload>(raw);
      const markdown = safeMarkdown(parsed.markdown);
      if (!markdown.includes('## 核心概念') || !markdown.includes('## 关键方法') || !markdown.includes('## 典型题')) {
        throw new Error('compiled markdown missing required sections');
      }
      return {
        markdown,
        summary: safeText(parsed.summary) || `由 ${scope.entries.length} 条原子知识和 ${scope.materials.length} 份材料编译生成`,
      };
    } catch {
      return this.buildFallbackPage(scope);
    }
  }

  private buildCompilePrompt(scope: SubjectScope): string {
    const buckets = new Map<typeof SECTION_ORDER[number], EntryRecord[]>();
    for (const label of SECTION_ORDER) {
      buckets.set(label, []);
    }
    for (const entry of scope.entries) {
      buckets.get(mapTypeToSection(entry.type))?.push(entry);
    }

    const representativeEntries: EntryRecord[] = [];
    for (const label of SECTION_ORDER) {
      const bucket = buckets.get(label) ?? [];
      representativeEntries.push(...bucket.slice(0, REPRESENTATIVE_LIMIT_PER_BUCKET));
    }

    const representativeSet = new Set(representativeEntries.map((entry) => entry.id));
    const representativeRelations = scope.relations.filter((relation) =>
      representativeSet.has(relation.source_id) && representativeSet.has(relation.target_id),
    );
    const entryById = new Map(scope.entries.map((entry) => [entry.id, entry]));

    const lines: string[] = [];
    lines.push(`subject_node_id: ${scope.subject.id}`);
    lines.push(`subject_name: ${scope.subject.name}`);
    lines.push(`parent_subject: ${scope.parent?.name ?? '无'}`);
    lines.push(`children: ${scope.children.length > 0 ? scope.children.map((child) => child.name).join('、') : '无'}`);
    lines.push(`descendant_scope_count: ${scope.descendantIds.length}`);
    lines.push(`atomic_entry_count: ${scope.entries.length}`);
    lines.push(`material_count: ${scope.materials.length}`);
    lines.push('');
    lines.push('【条目总量分布】');
    for (const type of ATOMIC_ENTRY_TYPES) {
      const count = scope.entries.filter((entry) => entry.type === type).length;
      lines.push(`- ${type}: ${count}`);
    }
    lines.push('');
    lines.push('【代表性原子知识条目】');
    for (const entry of representativeEntries) {
      const source = parseJsonObject(entry.source_json);
      const materialId = typeof source.materialId === 'string' ? source.materialId : '';
      const materialName = materialId ? scope.materials.find((item) => item.id === materialId)?.file_name ?? materialId : '未知材料';
      const page = typeof source.page === 'number' ? ` p.${source.page}` : '';
      const excerpt = trimForPrompt(entry.content.replace(/\s+/g, ' ').trim(), 360);
      lines.push(`- [${entry.type}] ${entry.title} | entry_id=${entry.id} | material=${materialName}${page}`);
      lines.push(`  ${excerpt}`);
    }
    lines.push('');
    lines.push('【其余条目标题】');
    for (const label of SECTION_ORDER) {
      const items = (buckets.get(label) ?? []).slice(REPRESENTATIVE_LIMIT_PER_BUCKET).map((entry) => entry.title);
      lines.push(`- ${label}: ${items.length > 0 ? items.join('；') : '无'}`);
    }
    lines.push('');
    lines.push('【图谱关系样本】');
    if (representativeRelations.length === 0) {
      lines.push('- 无');
    } else {
      for (const relation of representativeRelations) {
        const source = entryById.get(relation.source_id);
        const target = entryById.get(relation.target_id);
        if (!source || !target) continue;
        lines.push(`- ${source.title} -> ${target.title} | ${relation.association_type} | weight=${relation.weight.toFixed(2)}`);
      }
    }
    lines.push('');
    lines.push('【关联材料】');
    if (scope.materials.length === 0) {
      lines.push('- 无');
    } else {
      for (const material of scope.materials) {
        lines.push(`- ${material.file_name} | subject=${material.suggested_subject_name ?? material.subject_node_id ?? '未知'} | pipeline=${material.pipeline_status ?? 'unknown'}`);
      }
    }

    return lines.join('\n');
  }

  private buildFallbackPage(scope: SubjectScope): { markdown: string; summary: string } {
    const sectionLines = new Map<typeof SECTION_ORDER[number], string[]>();
    for (const label of SECTION_ORDER) {
      sectionLines.set(label, []);
    }

    for (const entry of scope.entries) {
      const label = mapTypeToSection(entry.type);
      const materialName = this.resolveMaterialName(scope.materials, entry.source_json);
      sectionLines.get(label)?.push(`- **${entry.title}**：${trimForPrompt(stripMarkdown(entry.content), 180)}${materialName ? `（来源：${materialName}）` : ''}`);
    }

    if (scope.entries.length === 0) {
      sectionLines.get('批注')?.push('- 当前学科节点还没有抽取完成的原子知识条目，先保留材料/子学科结构位。');
    }

    const related: string[] = [];
    if (scope.parent) related.push(`- 上级主题：${scope.parent.name}`);
    for (const child of scope.children) related.push(`- 下级主题：${child.name}`);
    if (related.length === 0) related.push('- 暂无关联主题');

    const sources = scope.entries.slice(0, 20).map((entry) => {
      const materialName = this.resolveMaterialName(scope.materials, entry.source_json) ?? '未知材料';
      return `- ${materialName} -> ${entry.title}`;
    });
    if (sources.length === 0) {
      for (const material of scope.materials.slice(0, 20)) {
        sources.push(`- ${material.file_name}`);
      }
    }
    if (sources.length === 0) sources.push('- 暂无来源材料');

    const parts: string[] = [];
    parts.push(`# ${scope.subject.name}`);
    parts.push('');
    parts.push(`> 本页由 ${scope.entries.length} 条原子知识、${scope.materials.length} 份关联材料自动编译生成。`);
    parts.push('');
    parts.push('## 目录');
    for (const label of SECTION_ORDER) {
      parts.push(renderHeadingLink(label));
    }
    parts.push(renderHeadingLink('关联主题'));
    parts.push(renderHeadingLink('来源溯源'));
    parts.push('');
    for (const label of SECTION_ORDER) {
      parts.push(`## ${label}`);
      const lines = sectionLines.get(label) ?? [];
      parts.push(lines.length > 0 ? lines.join('\n') : '暂无相关条目');
      parts.push('');
    }
    parts.push('## 关联主题');
    parts.push(related.join('\n'));
    parts.push('');
    parts.push('## 来源溯源');
    parts.push(sources.join('\n'));

    return {
      markdown: parts.join('\n').trim(),
      summary: `由 ${scope.entries.length} 条原子知识和 ${scope.materials.length} 份材料编译生成`,
    };
  }

  private resolveMaterialName(materials: MaterialRecord[], sourceJson: string): string | null {
    const source = parseJsonObject(sourceJson);
    const materialId = typeof source.materialId === 'string' ? source.materialId : null;
    if (!materialId) return null;
    return materials.find((material) => material.id === materialId)?.file_name ?? materialId;
  }

  private extractSections(markdown: string, entries: EntryRecord[]): WikiSection[] {
    const sections: WikiSection[] = [];
    const lines = markdown.split('\n');
    const entryBuckets = new Map<typeof SECTION_ORDER[number], string[]>();
    for (const label of SECTION_ORDER) {
      entryBuckets.set(label, []);
    }
    for (const entry of entries) {
      entryBuckets.get(mapTypeToSection(entry.type))?.push(entry.id);
    }

    let currentLabel: typeof SECTION_ORDER[number] | null = null;
    let buffer: string[] = [];
    const flush = () => {
      if (!currentLabel) return;
      sections.push({
        label: currentLabel,
        entryIds: entryBuckets.get(currentLabel) ?? [],
        markdown: buffer.join('\n').trim(),
      });
      buffer = [];
    };

    for (const line of lines) {
      const match = line.match(/^##\s+(核心概念|关键方法|典型题|易错点|批注)\s*$/);
      if (match) {
        flush();
        currentLabel = match[1] as typeof SECTION_ORDER[number];
        continue;
      }
      if (currentLabel) buffer.push(line);
    }
    flush();
    return sections;
  }

  private buildWikiLinks(pageId: string, scope: SubjectScope): WikiLink[] {
    const links: WikiLink[] = [];
    const seen = new Set<string>();

    const pushLink = (targetSubjectId: string | null, targetTitle: string, label: string) => {
      const key = `${targetSubjectId ?? 'null'}|${targetTitle}|${label}`;
      if (seen.has(key)) return;
      seen.add(key);
      links.push({
        sourcePageId: pageId,
        targetPageId: targetSubjectId ? this.findCompiledPageId(targetSubjectId) : null,
        targetTitle,
        label,
      });
    };

    if (scope.parent) pushLink(scope.parent.id, scope.parent.name, '上级主题');
    for (const child of scope.children) {
      pushLink(child.id, child.name, '下级主题');
    }

    const siblingRows = scope.parent
      ? (this.db.prepare(`
          SELECT id, name
          FROM subject_nodes
          WHERE parent_id = ? AND id != ? AND COALESCE(status, 'active') = 'active' AND merged_into IS NULL
          ORDER BY name ASC
          LIMIT 6
        `).all(scope.parent.id, scope.subject.id) as Array<{ id: string; name: string }>)
      : [];
    for (const sibling of siblingRows) {
      pushLink(sibling.id, sibling.name, '同层主题');
    }

    return links;
  }

  private persistCompiledPage(page: CompiledWikiPage, scope: SubjectScope): void {
    const tx = this.db.transaction(() => {
      const timestamp = nowIso();
      const previous = this.db.prepare(`
        SELECT content, summary, version, metadata_json
        FROM entries
        WHERE id = ? AND type = 'wiki_page'
      `).get(page.pageId) as { content: string; summary: string; version: number; metadata_json: string | null } | undefined;

      const nextVersion = Math.max(1, (previous?.version ?? 0) + 1);
      const sourceJson = JSON.stringify({
        compiler: COMPILER_ID,
        compiler_model: MODEL,
        subject_node_id: scope.subject.id,
        scope_subject_node_ids: scope.descendantIds,
        related_entry_ids: page.entryIds,
        related_material_ids: page.materialIds,
        compiled_at: timestamp,
      });
      const metadataJson = JSON.stringify({
        compiler: COMPILER_ID,
        compilerModel: MODEL,
        subjectNodeId: scope.subject.id,
        parentSubjectId: scope.parent?.id ?? null,
        childSubjectIds: scope.children.map((child) => child.id),
        entryCount: page.entryIds.length,
        materialCount: page.materialIds.length,
        linksCount: page.links.length,
        relationCount: scope.relations.length,
      });

      this.db.prepare(`
        UPDATE entries
        SET title = ?,
            content = ?,
            summary = ?,
            source_json = ?,
            metadata_json = ?,
            status = 'active',
            subject_id = ?,
            updated_at = ?,
            version = ?
        WHERE id = ? AND type = 'wiki_page'
      `).run(
        page.title,
        page.markdownBody,
        page.summary,
        sourceJson,
        metadataJson,
        scope.subject.id,
        timestamp,
        nextVersion,
        page.pageId,
      );

      this.db.prepare(`DELETE FROM wiki_links WHERE source_page_id = ?`).run(page.pageId);
      const insertLink = this.db.prepare(`
        INSERT OR REPLACE INTO wiki_links (
          source_page_id, target_page_id, target_title, label, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const link of page.links) {
        insertLink.run(
          link.sourcePageId,
          link.targetPageId,
          link.targetTitle,
          link.label,
          link.targetPageId ? 'resolved' : 'missing',
          timestamp,
          timestamp,
        );
      }

      this.db.prepare(`
        INSERT INTO wiki_page_versions (
          id, page_id, version, title, content, summary, tags_json, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        page.pageId,
        nextVersion,
        page.title,
        page.markdownBody,
        page.summary,
        JSON.stringify(['compiled', 'subject-wiki']),
        metadataJson,
        timestamp,
      );
    });

    tx();
  }

  private findCompiledPageId(subjectId: string): string | null {
    const row = this.db.prepare(`
      SELECT id
      FROM entries
      WHERE type = 'wiki_page'
        AND subject_id = ?
        AND metadata_json LIKE ?
      ORDER BY created_at ASC
      LIMIT 1
    `).get(subjectId, `%"compiler":"${COMPILER_ID}"%`) as { id: string } | undefined;
    return row?.id ?? null;
  }
}
