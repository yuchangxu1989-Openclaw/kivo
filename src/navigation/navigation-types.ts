export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon?: string;
  badge?: NavBadge;
  children?: NavItem[];
}

export interface NavBadge {
  count: number;
  variant: 'info' | 'warning' | 'error';
}

export type DashboardActionType =
  | 'start-research'
  | 'review-conflicts'
  | 'review-pending'
  | 'import-documents'
  | 'browse-intent'
  | 'browse-dictionary';

export interface DashboardAction {
  type: DashboardActionType;
  label: string;
  description: string;
  path: string;
  priority: number;
}

export interface SystemStatus {
  pendingConflicts: number;
  knowledgeGaps: number;
  pendingReviews: number;
  totalEntries: number;
  onboardingComplete: boolean;
}

export interface NavigationState {
  sidebar: NavItem[];
  dashboardActions: DashboardAction[];
  defaultRoute: string;
}
