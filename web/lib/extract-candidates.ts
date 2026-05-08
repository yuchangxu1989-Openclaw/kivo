import { PlainTextParser, MarkdownParser } from '@kivo/extraction/document-parser';
import type { KnowledgeType, KnowledgeSource } from '@kivo/types/index';
import type { ImportCandidate } from '@/app/api/v1/imports/route';

const mdParser = new MarkdownParser();
const txtParser = new PlainTextParser();

/**
 * Lightweight rule-based classifier for import preview.
 * Avoids pulling in the LLM-based Classifier which requires
 * Node.js fs/path and network access.
 */
function classifyLocal(text: string): KnowledgeType {
  const t = text.toLowerCase();
  if (/禁止|必须|不得|规则|约束|目标|愿景/.test(t)) return 'intent';
  if (/选择.*而非|决定|取舍|adr|选型/.test(t)) return 'decision';
  if (/步骤|流程|方法|框架|最佳实践|pattern/.test(t)) return 'methodology';
  if (/踩坑|教训|发现|经验|实际/.test(t)) return 'experience';
  if (/认知|反思|思维|元知识|理解/.test(t)) return 'meta';
  return 'fact';
}

export function extractCandidates(
  content: string,
  fileName: string,
  fileType: string,
): ImportCandidate[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const source: KnowledgeSource = {
    type: 'document',
    reference: fileName,
    timestamp: new Date(),
  };

  const parser = fileType === 'md' || fileType === 'markdown' ? mdParser : txtParser;
  const sections = parser.parse(trimmed, source);

  const candidates: ImportCandidate[] = [];
  let idx = 0;

  for (const section of sections) {
    const text = section.title
      ? `${section.title}\n${section.content}`
      : section.content;

    if (text.trim().length < 10) continue;

    const type = classifyLocal(text);
    idx++;

    const anchor = section.title
      ? `${section.title} · 原文前 ${Math.min(text.length, 120)} 字`
      : `第 ${idx} 段 · 原文前 ${Math.min(text.length, 120)} 字`;

    candidates.push({
      id: `cand-${String(idx).padStart(3, '0')}`,
      type,
      title: section.title || generateTitle(section.content),
      content: section.content.length > 500
        ? section.content.slice(0, 500) + '…'
        : section.content,
      sourceAnchor: anchor,
      status: 'pending',
    });
  }

  return candidates;
}

function generateTitle(content: string): string {
  const first = content.split(/[。\n.!?！？]/)[0]?.trim() ?? '';
  if (first.length <= 40) return first || '未命名段落';
  return first.slice(0, 40) + '…';
}
