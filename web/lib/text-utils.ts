/**
 * Shared text utilities for KIVO Web.
 */

/**
 * Build a short summary from raw content by collapsing whitespace and truncating.
 *
 * @param content  - The source text to summarise.
 * @param maxLen   - Maximum character length before truncation (default 120).
 * @returns A single-line summary string, or a fallback label when content is empty.
 */
export function buildSummary(content: string, maxLen = 120): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (!compact) return '手动创建的知识条目';
  return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}
