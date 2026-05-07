const TYPE_LABELS: Record<string, string> = {
  fact: '事实', decision: '决策', methodology: '方法论',
  experience: '经验', intent: '意图', meta: '元知识',
  rule: '规则', term: '术语',
};

const STATUS_LABELS: Record<string, string> = {
  active: '生效', draft: '草稿',
  conflict: '冲突中', superseded: '已替代',
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

export function priorityLabel(priority: string): string {
  return PRIORITY_LABELS[priority] || priority;
}
