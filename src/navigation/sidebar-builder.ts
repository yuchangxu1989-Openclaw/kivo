import type { NavItem, NavBadge, SystemStatus } from './navigation-types.js';

const FIXED_NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: '仪表盘', path: '/dashboard', icon: 'home' },
  { id: 'import', label: '文档导入', path: '/import', icon: 'upload' },
  { id: 'intent', label: '意图库', path: '/intent', icon: 'target' },
  { id: 'dictionary', label: '系统字典', path: '/dictionary', icon: 'book' },
  { id: 'knowledge', label: '知识库', path: '/knowledge', icon: 'database' },
  { id: 'conflicts', label: '冲突管理', path: '/conflicts', icon: 'alert-triangle' },
  { id: 'research', label: '调研任务', path: '/research', icon: 'search' },
  { id: 'audit', label: '操作审计', path: '/audit', icon: 'shield' },
];

export function buildSidebar(status: SystemStatus): NavItem[] {
  return FIXED_NAV_ITEMS.map((item) => {
    const badge = resolveBadge(item.id, status);
    return badge ? { ...item, badge } : item;
  });
}

function resolveBadge(itemId: string, status: SystemStatus): NavBadge | undefined {
  if (itemId === 'conflicts' && status.pendingConflicts > 0) {
    return { count: status.pendingConflicts, variant: 'warning' };
  }
  if (itemId === 'research' && status.knowledgeGaps > 0) {
    return { count: status.knowledgeGaps, variant: 'info' };
  }
  if (itemId === 'knowledge' && status.pendingReviews > 0) {
    return { count: status.pendingReviews, variant: 'info' };
  }
  return undefined;
}

export function getDefaultRoute(onboardingComplete: boolean): string {
  return onboardingComplete ? '/dashboard' : '/onboarding';
}

export { FIXED_NAV_ITEMS };
