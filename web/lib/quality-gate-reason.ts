/**
 * 质量门禁拒绝原因 → 用户可读文案
 *
 * 背景：repo.save() 只返回 boolean，拒绝细节写在 quality_gate_log。
 * spec 约束（product-requirements.md L59）：「质量门禁、向量化等内部机制不暴露给用户」，
 * 所以这里把内部 reason code 翻成人话，绝不回显 “质量门禁/向量化/embedding” 等术语。
 *
 * AC-A04-1 要求手动录入可用；AC-N05-9 要求所有写入都过门禁、禁止绕过。
 * 两者并存的解法：保留门禁，但把拒绝原因讲清楚，让用户知道怎么改。
 */

import { openWebDb } from '@/lib/db';

export type RejectReasonCode = 'low_value' | 'duplicate' | 'internalized' | 'unknown';

export interface RejectReason {
  code: RejectReasonCode;
  /** 用户可读文案，无内部术语 */
  message: string;
  /** 命中重复时，已存在的相似条目标题（如有） */
  matchedTitle?: string;
}

const FALLBACK: RejectReason = {
  code: 'unknown',
  message: '这条知识没有通过入库检查。可能是内容偏通用、价值不够具体，或与已有条目重复。请补充更具体、可指导决策或行动的内容后重试。',
};

const LOW_VALUE: RejectReason = {
  code: 'low_value',
  message: '这条内容偏通用或价值不够具体，没有入库。请写成能指导具体决策或行动、带有你自己判断的知识后重试。',
};

const INTERNALIZED: RejectReason = {
  code: 'internalized',
  message: '这条属于通用常识，知识库里不需要单独记录。请补充你自己的判断、约束或私有经验后重试。',
};

function duplicateReason(matchedTitle?: string): RejectReason {
  return {
    code: 'duplicate',
    matchedTitle,
    message: matchedTitle
      ? `知识库里已经有一条很接近的内容「${matchedTitle}」，这条没有重复入库。如果想补充新角度，可以编辑那条已有知识。`
      : '知识库里已经有一条很接近的内容，这条没有重复入库。如果想补充新角度，可以编辑那条已有知识。',
  };
}

/**
 * 按 entryId 反查最近一次门禁判定，翻成用户可读文案。
 * 查不到记录（例如去重早退路径不写日志）时回退到通用提示。
 */
export function lookupRejectReason(entryId: string): RejectReason {
  try {
    const db = openWebDb(true);
    try {
      const row = db
        .prepare(
          `SELECT reason, matched_entry_title
             FROM quality_gate_log
            WHERE entry_id = ?
            ORDER BY created_at DESC
            LIMIT 1`,
        )
        .get(entryId) as { reason?: string; matched_entry_title?: string } | undefined;

      if (!row) return FALLBACK;
      if (row.reason === 'duplicate') return duplicateReason(row.matched_entry_title || undefined);
      if (row.reason === 'low_value') return LOW_VALUE;
      if (row.reason === 'llm_internalized') return INTERNALIZED;
      return FALLBACK;
    } finally {
      db.close();
    }
  } catch {
    return FALLBACK;
  }
}
