const TYPE_LABELS: Record<string, string> = {
  fact: '事实', decision: '决策', methodology: '方法论',
  experience: '经验', intent: '意图', meta: '元知识',
  rule: '规则', term: '术语',
};

const STATUS_LABELS: Record<string, string> = {
  pending: '待审', active: '生效', rejected: '已拒绝',
  superseded: '已替代', conflicted: '冲突中',
  // legacy aliases still present in older rows
  draft: '草稿', conflict: '冲突中',
};

const NATURE_LABELS: Record<string, string> = {
  fact: '事实', decision: '决策', methodology: '方法论',
  experience: '经验', meta: '元知识',
};

const FUNCTION_LABELS: Record<string, string> = {
  constraint: '约束', preference: '偏好', pattern: '模式', principle: '原则',
};

const PRIORITY_LABELS: Record<string, string> = {
  high: '高', medium: '中', low: '低', critical: '紧急',
};

export { TYPE_LABELS };

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] || type;
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] || status;
}

export function natureLabel(nature: string): string {
  return NATURE_LABELS[nature] || nature;
}

export function functionLabel(fn: string): string {
  return FUNCTION_LABELS[fn] || fn;
}

export const KNOWLEDGE_STATUSES = ['pending', 'active', 'rejected', 'superseded', 'conflicted'] as const;
export const KNOWLEDGE_NATURES = ['fact', 'decision', 'methodology', 'experience', 'meta'] as const;
export const KNOWLEDGE_FUNCTIONS = ['constraint', 'preference', 'pattern', 'principle'] as const;

export function priorityLabel(priority: string): string {
  return PRIORITY_LABELS[priority] || priority;
}
