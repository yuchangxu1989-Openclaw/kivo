import type { DashboardAction, SystemStatus } from './navigation-types.js';

export function recommendActions(status: SystemStatus): DashboardAction[] {
  const actions: DashboardAction[] = [];

  if (status.pendingConflicts > 0) {
    actions.push({
      type: 'review-conflicts',
      label: '处理冲突',
      description: `${status.pendingConflicts} 条知识冲突待裁决`,
      path: '/conflicts',
      priority: 1,
    });
  }

  if (status.knowledgeGaps > 0) {
    actions.push({
      type: 'start-research',
      label: '启动调研',
      description: `${status.knowledgeGaps} 个知识缺口待补充`,
      path: '/research',
      priority: 2,
    });
  }

  if (status.pendingReviews > 0) {
    actions.push({
      type: 'review-pending',
      label: '审核知识',
      description: `${status.pendingReviews} 条知识待确认`,
      path: '/knowledge?status=pending',
      priority: 3,
    });
  }

  if (status.totalEntries === 0) {
    actions.push({
      type: 'import-documents',
      label: '导入文档',
      description: '知识库为空，导入文档开始构建',
      path: '/import',
      priority: 0,
    });
  }

  return actions.sort((a, b) => a.priority - b.priority);
}
