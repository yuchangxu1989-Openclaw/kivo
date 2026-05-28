/**
 * Operation Log Integration — hooks into existing KIVO flows to emit operation log events.
 *
 * Import this module from server-side routes that perform write operations.
 * Each function writes a persistent operation_logs record and triggers SSE push.
 */

import { writeOperationLog, type OperationEventType } from './operation-log-db';

// ─── Knowledge Change Events ────────────────────────────────────────────────

export function logKnowledgeCreated(title: string, type: string, source?: string) {
  writeOperationLog(
    'knowledge_change',
    `知识条目创建: ${title}`,
    `类型: ${type}`,
    { action: 'create', knowledge_type: type, source: source || 'manual' },
  );
}

export function logKnowledgeDeleted(title: string, type: string) {
  writeOperationLog(
    'knowledge_change',
    `知识条目删除: ${title}`,
    `类型: ${type}`,
    { action: 'delete', knowledge_type: type },
  );
}

export function logKnowledgeMerged(titles: string[], mergedInto: string) {
  writeOperationLog(
    'knowledge_change',
    `知识条目合并: ${titles.length} 条 → ${mergedInto}`,
    `合并来源: ${titles.join(', ')}`,
    { action: 'merge', count: titles.length, target: mergedInto },
  );
}

// ─── Document Import Events ─────────────────────────────────────────────────

export function logDocumentImport(fileName: string, knowledgeCount: number) {
  writeOperationLog(
    'document_import',
    `文档导入: ${fileName}`,
    `产出 ${knowledgeCount} 条知识`,
    { file_name: fileName, count: knowledgeCount },
  );
}

// ─── Research Complete Events ───────────────────────────────────────────────

export function logResearchComplete(topic: string, reportPath?: string) {
  writeOperationLog(
    'research_complete',
    `调研完成: ${topic}`,
    reportPath ? `报告: ${reportPath}` : '',
    { topic, report_path: reportPath || '' },
  );
}

// ─── Governance Run Events ──────────────────────────────────────────────────

export function logGovernanceRun(merged: number, cleaned: number, summary?: string) {
  writeOperationLog(
    'governance_run',
    `治理运行: 合并 ${merged} 条, 清理 ${cleaned} 条`,
    summary || '',
    { merged, cleaned },
  );
}

// ─── Vectorization Batch Events ─────────────────────────────────────────────

export function logVectorizationBatch(count: number, durationMs?: number) {
  writeOperationLog(
    'vectorization_batch',
    `向量化完成: ${count} 条`,
    durationMs ? `耗时 ${(durationMs / 1000).toFixed(1)}s` : '',
    { count, duration_ms: durationMs },
  );
}
