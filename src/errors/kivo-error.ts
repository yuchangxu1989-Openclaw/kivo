/**
 * KivoError — 用户友好的结构化错误类
 *
 * FR-Z07: 错误描述 + 可能原因 + 修复建议 + 可重试标记 + 诊断信息
 */

import { ERROR_CATALOG, type ErrorEntry, type ErrorCategory } from './error-catalog.js';

export class KivoError extends Error {
  readonly code: string;
  readonly cause_description: string;
  readonly suggestion: string;
  readonly retryable: boolean;
  readonly category: ErrorCategory;
  readonly diagnostics: Record<string, unknown>;

  constructor(
    code: string,
    overrides?: Partial<Pick<ErrorEntry, 'message' | 'cause' | 'suggestion'>>,
    diagnostics?: Record<string, unknown>,
  ) {
    const entry = ERROR_CATALOG[code];
    const message = overrides?.message ?? entry?.message ?? `Unknown error: ${code}`;
    super(message);
    this.name = 'KivoError';
    this.code = code;
    this.cause_description = overrides?.cause ?? entry?.cause ?? '';
    this.suggestion = overrides?.suggestion ?? entry?.suggestion ?? '';
    this.retryable = entry?.retryable ?? false;
    this.category = entry?.category ?? 'config';
    this.diagnostics = diagnostics ?? {};
  }

  /** 生成用户可读的完整错误信息 */
  toUserMessage(): string {
    const lines = [`[${this.code}] ${this.message}`];
    if (this.cause_description) lines.push(`原因: ${this.cause_description}`);
    if (this.suggestion) lines.push(`建议: ${this.suggestion}`);
    if (this.retryable) lines.push('此操作支持重试。');
    return lines.join('\n');
  }

  /** 生成可复制的诊断信息（供提交给支持人员） */
  toDiagnosticString(): string {
    return JSON.stringify({
      code: this.code,
      message: this.message,
      category: this.category,
      retryable: this.retryable,
      diagnostics: this.diagnostics,
      stack: this.stack?.split('\n').slice(0, 5),
    }, null, 2);
  }

  /** 序列化为 API 响应格式 */
  toJSON(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        cause: this.cause_description,
        suggestion: this.suggestion,
        retryable: this.retryable,
        category: this.category,
      },
    };
  }
}

/**
 * 将任意错误包装为 KivoError。
 * 已经是 KivoError 的直接返回；原生 Error 映射到最接近的错误码。
 */
export function wrapError(
  err: unknown,
  fallbackCode: string = 'KIVO-CFG-001',
  diagnostics?: Record<string, unknown>,
): KivoError {
  if (err instanceof KivoError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const mapped = inferErrorCode(message);
  const code = mapped ?? fallbackCode;

  return new KivoError(code, { message }, diagnostics);
}

/** 根据错误消息关键词推断错误码 */
function inferErrorCode(message: string): string | null {
  const lower = message.toLowerCase();
  if (lower.includes('sqlite') || lower.includes('database')) return 'KIVO-STG-002';
  if (lower.includes('embedding')) return 'KIVO-EMB-002';
  if (lower.includes('api key') || lower.includes('apikey')) return 'KIVO-CFG-003';
  if (lower.includes('not initialized')) return 'KIVO-BST-001';
  if (lower.includes('pipeline failed')) return 'KIVO-ING-001';
  return null;
}
