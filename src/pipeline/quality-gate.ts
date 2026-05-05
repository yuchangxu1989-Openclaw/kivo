/**
 * Quality gate stage — filters low-value entries before persistence.
 */

export interface QualityGateResult {
  passed: boolean;
  reason?: string;
}

export function evaluateQuality(entry: {
  title: string;
  content: string;
}): QualityGateResult {
  if (entry.content.length < 50) {
    return { passed: false, reason: 'content_too_short' };
  }

  const normalizedContent = entry.content.trim();
  const statusPatterns = /^(任务|已完成|已修复|已部署|已发布|done|completed|fixed|deployed)/i;
  if (normalizedContent.length <= 200 && statusPatterns.test(normalizedContent)) {
    return { passed: false, reason: 'status_log' };
  }

  if (entry.title.trim() === normalizedContent) {
    return { passed: false, reason: 'title_equals_content' };
  }

  return { passed: true };
}
